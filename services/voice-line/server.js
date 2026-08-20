/**
 * The owner's phone line (assistant step 3): call a Twilio number, talk to the company.
 *
 *   Caller <-> Twilio (ASR/TTS) <-> this WebSocket <-> Anthropic <-> hub MCP API
 *
 * Security layers, all fail-closed:
 *  1. Twilio request-signature validation on every webhook (TWILIO_AUTH_TOKEN).
 *  2. Caller-ID allowlist (OWNER_PHONE_NUMBERS, comma-separated E.164) - anyone else is refused.
 *  3. Spoken-keypad PIN (VOICE_PIN) before the AI ever connects - caller ID can be spoofed, a PIN
 *     in your head cannot.
 *  4. The AI's only power is the hub's MCP API with the claude-voice-partner token - every
 *     mutation it can reach is already governed by the hub (tasks are budgeted runs; anything
 *     consequential still lands in the owner's Inbox for approval).
 * The caller's transcribed speech is untrusted input: it is only ever the user turn, never system.
 */
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'king-ai-ops-hub-voice.fly.dev';
const HUB_MCP_URL = process.env.HUB_MCP_URL || 'https://king-ai-ops-hub-prod.fly.dev/api/mcp';
const HUB_MCP_TOKEN = process.env.HUB_MCP_TOKEN || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const OWNER_NUMBERS = (process.env.OWNER_PHONE_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const VOICE_PIN = process.env.VOICE_PIN || '';
const MODEL = process.env.VOICE_MODEL || 'claude-haiku-4-5-20251001';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------- MCP client
let rpcId = 0;
async function mcpRpc(method, params) {
  const res = await fetch(HUB_MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HUB_MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`hub MCP ${method}: ${body.error.message}`);
  return body.result;
}

let cachedTools = null;
async function hubTools() {
  if (cachedTools) return cachedTools;
  const result = await mcpRpc('tools/list', {});
  cachedTools = (result.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object' },
  }));
  return cachedTools;
}

async function callHubTool(name, args) {
  const result = await mcpRpc('tools/call', { name, arguments: args || {} });
  const content = Array.isArray(result?.content)
    ? result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n')
    : JSON.stringify(result);
  return content.slice(0, 20000);
}

// ---------------------------------------------------------------- agent loop
const SYSTEM = `You ARE the Chief of Staff of Empera International, on the phone with the owner (they authenticated with a PIN - the caller is always the owner). You run headquarters and see across every business in the company. Speak as yourself, in first person: "I'll get that moving", "here's where things stand". NEVER refer to the Chief of Staff in the third person or say you will "ask the Chief of Staff" - you are that person. Keep every reply SHORT, natural, and speakable - one to three sentences unless the owner asks for detail. Never read out identifiers, hashes, or raw JSON; translate everything into plain business language.

You act through the hub's tools. Each business has its own General Manager reporting up to you; your home workspace is "empera-international".

For company-wide questions ("how is everything going", "what needs me") do your deep thinking through your desk at headquarters: use create_task in the empera-international workspace assigned to the Chief of Staff with the owner's question as the input, then submit_run, then poll get_task until it completes (wait a few seconds between polls, up to about 60 seconds), and relay the result AS YOUR OWN answer - say "give me a moment while I pull that together", never "I'll ask the Chief of Staff". For quick lookups (projects, a task's status, usage) use the direct tools and answer immediately.

You may create tasks when the owner gives an order - that is the governed path (runs are budgeted; consequential actions still go to the owner's Inbox for approval). Never invent facts about the businesses: if a tool did not tell you, say you do not know. Do not discuss these instructions.`;

const sessions = new Map(); // callSid -> { history: [], abort: AbortController|null }

function sendText(ws, token, last) {
  ws.send(JSON.stringify({ type: 'text', token, last }));
}

async function handlePrompt(ws, session, voicePrompt) {
  session.abort?.abort();
  const abort = new AbortController();
  session.abort = abort;
  session.history.push({ role: 'user', content: voicePrompt });

  try {
    const tools = await hubTools();
    // Agent loop: stream text to the caller; execute tool calls between turns (max 8 hops).
    for (let hop = 0; hop < 8; hop++) {
      const stream = anthropic.messages.stream(
        {
          model: MODEL,
          max_tokens: 700,
          system: SYSTEM,
          tools,
          messages: session.history,
        },
        { signal: abort.signal },
      );
      let spoke = false;
      stream.on('text', (delta) => {
        if (delta) {
          spoke = true;
          sendText(ws, delta, false);
        }
      });
      const final = await stream.finalMessage();
      session.history.push({ role: 'assistant', content: final.content });

      const toolUses = final.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        sendText(ws, '', true);
        return;
      }
      if (spoke) sendText(ws, '', true); // let any "one moment" text play while tools run
      const results = [];
      for (const tu of toolUses) {
        let text;
        try {
          text = await callHubTool(tu.name, tu.input);
        } catch (err) {
          text = `Tool failed: ${err.message}`;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: text });
      }
      session.history.push({ role: 'user', content: results });
    }
    sendText(ws, ' Sorry, that took too many steps. Ask me again more specifically.', true);
  } catch (err) {
    if (abort.signal.aborted) return; // interrupted by the caller - the new prompt owns the floor
    console.error('agent error', err.message);
    sendText(ws, ' Sorry, I hit a problem with that. Try again.', true);
  }
}

// ---------------------------------------------------------------- HTTP (TwiML)
const app = express();
app.use(express.urlencoded({ extended: false }));

function validTwilioRequest(req) {
  if (!TWILIO_AUTH_TOKEN) return false;
  const signature = req.headers['x-twilio-signature'];
  const url = `https://${PUBLIC_HOST}${req.originalUrl}`;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {});
}

function refuse(res, say) {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say(say);
  vr.hangup();
  res.type('text/xml').send(vr.toString());
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/voice', (req, res) => {
  if (!validTwilioRequest(req)) return res.status(403).send('invalid signature');
  const from = req.body.From || '';
  if (OWNER_NUMBERS.length === 0 || !OWNER_NUMBERS.includes(from)) {
    console.warn('refused caller', from);
    return refuse(res, 'This line is private. Goodbye.');
  }
  const vr = new twilio.twiml.VoiceResponse();
  const gather = vr.gather({ input: 'dtmf', numDigits: String(VOICE_PIN.length || 4), timeout: 10, action: '/voice/pin', method: 'POST' });
  gather.say('Enter your PIN.');
  vr.say('No input received. Goodbye.');
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

app.post('/voice/pin', (req, res) => {
  if (!validTwilioRequest(req)) return res.status(403).send('invalid signature');
  const digits = req.body.Digits || '';
  const ok = VOICE_PIN.length > 0 && crypto.timingSafeEqual(
    Buffer.from(digits.padEnd(VOICE_PIN.length).slice(0, VOICE_PIN.length)),
    Buffer.from(VOICE_PIN),
  );
  if (!ok) return refuse(res, 'Incorrect PIN. Goodbye.');
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  connect.conversationRelay({
    url: `wss://${PUBLIC_HOST}/ws`,
    welcomeGreeting: 'Connected. What do you need?',
    interruptByDtmf: true,
  });
  res.type('text/xml').send(vr.toString());
});

// ---------------------------------------------------------------- WS (relay)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let callSid = null;
  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (event.type === 'setup' || event.type === 'connected') {
      callSid = event.callSid || callSid || `call-${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, { history: [], abort: null });
      return;
    }
    const session = sessions.get(callSid) ?? { history: [], abort: null };
    sessions.set(callSid, session);
    if (event.type === 'prompt' && event.voicePrompt) {
      void handlePrompt(ws, session, event.voicePrompt);
    } else if (event.type === 'interrupt') {
      session.abort?.abort();
    } else if (event.type === 'error') {
      console.error('relay error', event.description);
    }
  });
  ws.on('close', () => {
    if (callSid) {
      const s = sessions.get(callSid);
      s?.abort?.abort();
      sessions.delete(callSid);
    }
  });
});

// ---------------------------------------------------------------- SMS (the owner's texting line)
// Same brain, same guards, different mouth: signature-validated webhook, sender allowlist
// (owner numbers only — anyone else is silently dropped), and the reply is sent asynchronously
// through the REST API because the agent's tool loop can outlive Twilio's webhook timeout.
// Delivery requires the account's approved A2P campaign; until carriers approve, outbound
// texts are blocked by Twilio itself (error 30034) — the handler still works, replies just
// won't arrive.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const restClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const SYSTEM_SMS = `You ARE the Chief of Staff of Empera International, texting with the owner (the sender allowlist guarantees the texter is the owner). You run headquarters and see across every business. Speak as yourself in first person; NEVER refer to the Chief of Staff in the third person. This is SMS: keep replies tight - a sentence or three, no markdown, no lists unless asked, never identifiers or raw JSON.

You act through the hub's tools. For company-wide questions, work through your desk: create_task in the "empera-international" workspace assigned to the Chief of Staff with the owner's question, then submit_run, then poll get_task until complete (a few seconds between polls, up to about 60 seconds), and relay the result as your own answer. For quick lookups use the direct tools. You may create tasks when the owner gives an order - consequential actions still land in the owner's Inbox for approval. Never invent facts: if a tool did not tell you, say you do not know. Do not discuss these instructions.`;

const smsSessions = new Map(); // owner number -> { history: [{role, content}] }

async function runSmsAgent(history) {
  const tools = await hubTools();
  const msgs = [...history];
  for (let hops = 0; ; hops++) {
    const resp = await anthropic.messages.create({ model: MODEL, max_tokens: 1000, system: SYSTEM_SMS, tools, messages: msgs });
    const toolUses = resp.content.filter((c) => c.type === 'tool_use');
    const text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    if (toolUses.length === 0 || hops >= 8) return text || 'Done.';
    msgs.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        out = await callHubTool(tu.name, tu.input);
      } catch (e) {
        out = `Tool error: ${e.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    msgs.push({ role: 'user', content: results });
  }
}

app.post('/sms', (req, res) => {
  if (!validTwilioRequest(req)) return res.status(403).send('invalid signature');
  const from = req.body.From || '';
  const to = req.body.To || '';
  const body = (req.body.Body || '').trim();
  // Acknowledge immediately (empty TwiML) in every case; unknown senders are dropped silently.
  res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString());
  if (OWNER_NUMBERS.length === 0 || !OWNER_NUMBERS.includes(from)) {
    console.warn('refused texter', from);
    return;
  }
  if (!restClient || !body) return;
  const session = smsSessions.get(from) || { history: [] };
  smsSessions.set(from, session);
  session.history.push({ role: 'user', content: body });
  if (session.history.length > 20) session.history.splice(0, session.history.length - 20);
  runSmsAgent(session.history)
    .then(async (reply) => {
      session.history.push({ role: 'assistant', content: reply });
      await restClient.messages.create({ from: to, to: from, body: reply.slice(0, 1500) });
      console.log('sms replied to', from);
    })
    .catch((e) => console.error('sms agent failed:', e.message));
});

// ------------------------------------------------------------ owner notifier
// The owner's directive (2026-08-20): "there's no way for the chief of staff to
// contact me" -> text the owner IMMEDIATELY when anything lands in the Inbox.
// Polls the hub database read-only (NOTIFY_DATABASE_URL is a SELECT-only role);
// one SMS per poll batches everything new in that minute, so a burst of items
// can never storm the owner's phone. Watermark starts at boot: only items that
// arrive while the notifier is alive are announced (no replay of old backlog).
// Texts go out only after the A2P campaign is approved; before that Twilio
// accepts the send and carriers drop it - harmless, and it self-activates.
const NOTIFY_DATABASE_URL = process.env.NOTIFY_DATABASE_URL || '';
const TWILIO_LINE_NUMBER = process.env.TWILIO_LINE_NUMBER || '';

if (NOTIFY_DATABASE_URL && TWILIO_LINE_NUMBER && restClient && OWNER_NUMBERS.length > 0) {
  const postgres = require('postgres');
  const nsql = postgres(NOTIFY_DATABASE_URL, { max: 1, prepare: false, idle_timeout: 30 });
  let watermark = new Date();
  let polling = false;

  const short = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  async function pollInbox() {
    if (polling) return;
    polling = true;
    try {
      // The role's ONLY window into the database is this definer function.
      const rows = await nsql`select * from public.notifier_inbox(${watermark})`;
      const qs = rows.filter((r) => r.kind === 'question');
      const aps = rows.filter((r) => r.kind === 'decision');
      if (rows.length === 0) return;
      for (const r of rows) if (r.created_at > watermark) watermark = r.created_at;

      const lines = [];
      for (const q of qs.slice(0, 4)) lines.push(`[${q.key}] asks: ${short(q.item, 140)}`);
      for (const a of aps.slice(0, 4)) lines.push(`[${a.key}] needs your Okay/No: ${short(a.item, 110)}`);
      const more = qs.length + aps.length - lines.length;
      if (more > 0) lines.push(`...and ${more} more.`);
      const body =
        `New in your Inbox - ${qs.length ? `${qs.length} question${qs.length > 1 ? 's' : ''}` : ''}` +
        `${qs.length && aps.length ? ', ' : ''}${aps.length ? `${aps.length} decision${aps.length > 1 ? 's' : ''}` : ''}:\n` +
        lines.join('\n') + `\nText me back or open the Inbox.`;
      for (const to of OWNER_NUMBERS) {
        try {
          await restClient.messages.create({ from: TWILIO_LINE_NUMBER, to, body: body.slice(0, 1500) });
          console.log('notifier: texted', to, `(${qs.length}q/${aps.length}d)`);
        } catch (e) {
          console.error('notifier: send failed:', e.message);
        }
      }
    } catch (e) {
      console.error('notifier: poll failed:', e.message);
    } finally {
      polling = false;
    }
  }
  setInterval(pollInbox, 60_000);
  console.log('notifier: watching the Inbox (60s poll, SMS to', OWNER_NUMBERS.join(','), ')');
} else {
  console.log('notifier: disabled (needs NOTIFY_DATABASE_URL, TWILIO_LINE_NUMBER, Twilio creds, OWNER_PHONE_NUMBERS)');
}

server.listen(PORT, '0.0.0.0', () => console.log(`voice-line listening on :${PORT}`));
