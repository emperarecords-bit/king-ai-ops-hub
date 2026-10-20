/**
 * Ops Chat approval content view — a bounded, read-only, redacted rendering of a stored
 * approval's `payload`, so the owner can review EXACTLY what they would approve or reject
 * (the draft email text, the HTTP request, the quote lines) without reading the DB.
 *
 * Pure and side-effect-free: it never writes, never executes, and never changes the payload
 * (the approval's payload hash is untouched — this only shapes a display copy). The caller is
 * responsible for authorization: Ops Chat renders it only for workspace ADMINS (the people
 * who can decide approvals), from the row read through the tenant boundary — never from
 * model text.
 *
 * Bounds: at most MAX_FIELDS short labelled fields (each ≤ MAX_FIELD_CHARS) plus one body
 * (≤ MAX_BODY_CHARS for an email/reply text, ≤ MAX_PREVIEW_CHARS for an HTTP body or a JSON
 * preview). Anything longer is cut and `truncated` is set.
 *
 * Redaction: any key that names a credential (password, secret, token, api key, authorization,
 * cookie, private key, …) has its value replaced, and credential-shaped strings (Bearer
 * headers, sk-/ghp_/xox… keys, JWTs, AWS access keys, URL userinfo, token query params) are
 * scrubbed from every rendered string.
 */

export const MAX_FIELDS = 12;
export const MAX_FIELD_CHARS = 300;
/** Email/reply bodies: the AccurateBids reply contract allows 5000 chars — show all of it. */
export const MAX_BODY_CHARS = 6000;
export const MAX_PREVIEW_CHARS = 2000;
export const REDACTED = '[redacted]';

export type ApprovalContentFormat = 'email' | 'http' | 'quote' | 'invoice' | 'json';

export interface ApprovalContentView {
  readonly format: ApprovalContentFormat;
  /** One-line description of what the content is (e.g. "Email reply to an AccurateBids inquiry"). */
  readonly title: string;
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** The main text — the email body, the HTTP body summary, the line items, or a JSON preview. */
  readonly body: string | null;
  /** Something was cut to fit the caps. */
  readonly truncated: boolean;
  /** At least one value was redacted as a credential. */
  readonly redacted: boolean;
}

// Key fragments (normalized: lowercase, no separators) that mark a credential-bearing field.
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'accesskey',
  'sessionid',
  'signature',
  'bearer',
];
const SECRET_KEYS_EXACT = new Set(['pwd', 'auth', 'jwt', 'otp', 'pin', 'cvv', 'ssn', 'key']);

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS_EXACT.has(k) || SECRET_KEY_FRAGMENTS.some((f) => k.includes(f));
}

const SECRET_VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // URL userinfo: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Credential-named query parameters: ?token=…&api_key=…
  [
    /([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|client_secret|password|sig|signature|auth)=)[^&#\s]+/gi,
    `$1${REDACTED}`,
  ],
];

interface Acc {
  truncated: boolean;
  redacted: boolean;
}

function scrub(s: string, acc: Acc): string {
  let out = s;
  for (const [re, rep] of SECRET_VALUE_PATTERNS) {
    const next = out.replace(re, rep);
    if (next !== out) acc.redacted = true;
    out = next;
  }
  return out;
}

function cap(s: string, max: number, acc: Acc): string {
  if (s.length <= max) return s;
  acc.truncated = true;
  return `${s.slice(0, max)}… [truncated, ${s.length - max} more chars]`;
}

/** Deep copy with credential-named keys replaced and string values scrubbed. Bounded depth. */
function redactValue(v: unknown, acc: Acc, depth = 0): unknown {
  if (typeof v === 'string') return scrub(v, acc);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 8) {
    acc.truncated = true;
    return '[nested too deep]';
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, acc, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    // Numbers/booleans (e.g. `max_tokens: 1000`) are not credentials; strings and objects are.
    if (isSecretKey(k) && (typeof val === 'string' ? val !== '' : val !== null && typeof val === 'object')) {
      acc.redacted = true;
      out[k] = REDACTED;
    } else {
      out[k] = redactValue(val, acc, depth + 1);
    }
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function firstStr(p: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = p[k];
    if (Array.isArray(v)) {
      const joined = v.map(str).filter((x): x is string => x !== null).join(', ');
      if (joined) return joined;
    }
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

function jsonPreview(v: unknown, acc: Acc, max = MAX_PREVIEW_CHARS): string {
  let text: string;
  try {
    text = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v));
  } catch {
    text = '[unserializable payload]';
  }
  return cap(text, max, acc);
}

class Builder {
  readonly acc: Acc = { truncated: false, redacted: false };
  private readonly fields: Array<{ label: string; value: string }> = [];
  field(label: string, value: string | null): this {
    if (value === null) return this;
    if (this.fields.length >= MAX_FIELDS) {
      this.acc.truncated = true;
      return this;
    }
    this.fields.push({ label, value: cap(scrub(value, this.acc), MAX_FIELD_CHARS, this.acc) });
    return this;
  }
  build(format: ApprovalContentFormat, title: string, body: string | null): ApprovalContentView {
    return { format, title, fields: this.fields, body, truncated: this.acc.truncated, redacted: this.acc.redacted };
  }
}

function renderEmail(p: Record<string, unknown>, title: string): ApprovalContentView | null {
  const b = new Builder();
  const text = firstStr(p, ['reply_text', 'body', 'text', 'message', 'content', 'html']);
  if (text === null) return null;
  b.field('To', firstStr(p, ['to', 'recipient', 'recipients', 'email', 'customer_email']))
    .field('Cc', firstStr(p, ['cc']))
    .field('Subject', firstStr(p, ['subject']))
    .field('Inquiry', firstStr(p, ['request_id']));
  return b.build('email', title, cap(scrub(text, b.acc), MAX_BODY_CHARS, b.acc));
}

function money(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '?';
}

function lineList(v: unknown, fmt: (x: Record<string, unknown>) => string): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(fmt);
}

function renderQuoteOrInvoice(p: Record<string, unknown>, kind: 'quote' | 'invoice'): ApprovalContentView {
  const b = new Builder();
  b.field('Customer', firstStr(p, ['customer_name']))
    .field('Customer email', firstStr(p, ['customer_email']))
    .field('Customer phone', firstStr(p, ['customer_phone']))
    .field('Job', firstStr(p, ['job_name']))
    .field('Address', firstStr(p, ['job_address']))
    .field('Job type', firstStr(p, ['job_type']))
    .field('From quote', firstStr(p, ['quote_id']))
    .field('Markup %', firstStr(p, ['markup_percent']))
    .field('Tax %', firstStr(p, ['tax_percent']))
    .field('Due (days)', firstStr(p, ['due_days']));
  const lines = [
    ...lineList(p.materials, (m) => `Material: ${str(m.description) ?? '?'} — ${str(m.quantity) ?? '?'} ${str(m.unit) ?? ''} × ${money(m.unit_cost)}`),
    ...lineList(p.labor, (l) => `Labor: ${str(l.description) ?? '?'} — ${str(l.hours) ?? '?'} h × ${money(l.hourly_rate)}`),
    ...lineList(p.additional_charges, (c) => `Charge: ${str(c.description) ?? '?'} — ${money(c.amount)}`),
    ...lineList(p.line_items, (i) => `Item: ${str(i.description) ?? '?'} — ${str(i.qty) ?? '?'} ${str(i.unit) ?? ''} × ${money(i.unit_price)}`),
  ];
  const notes = str(p.notes);
  const body = [...lines, ...(notes ? ['', `Notes: ${notes}`] : [])].join('\n');
  return b.build(
    kind,
    kind === 'quote' ? 'AccurateBids draft quote' : 'AccurateBids invoice (created as a real unpaid invoice)',
    body ? cap(scrub(body, b.acc), MAX_BODY_CHARS, b.acc) : null,
  );
}

function renderSend(p: Record<string, unknown>): ApprovalContentView {
  const b = new Builder();
  const send = firstStr(p, ['send']);
  const what = send === 'quote' ? 'quote' : send === 'invoice_reminder' ? 'payment reminder for invoice' : 'invoice';
  b.field('Sends', what)
    .field('Record', firstStr(p, ['label']))
    .field('Invoice id', firstStr(p, ['invoice_id']))
    .field('Quote id', firstStr(p, ['quote_id']))
    // Shown in full: this is the address the owner is confirming will be saved and emailed.
    .field('Save + email to', firstStr(p, ['customer_email']));
  const saving = Boolean(firstStr(p, ['customer_email']));
  return b.build(
    'email',
    `${saving ? 'Save this email on the invoice (it has none on file), then email' : 'Email'} the ${what} to the customer through AccurateBids (its own "View & ${send === 'quote' ? 'Approve' : 'Pay'}" email)`,
    null,
  );
}

function renderHttp(p: Record<string, unknown>): ApprovalContentView {
  const b = new Builder();
  b.field('Method', (firstStr(p, ['method']) ?? 'unspecified').toUpperCase()).field(
    'URL',
    firstStr(p, ['url', 'endpoint']) ?? 'unspecified',
  );
  const headers = p.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const names = Object.keys(headers as Record<string, unknown>);
    if (names.length) b.field('Headers', names.join(', ') + ' (values not shown)');
  }
  const rawBody = p.body ?? p.data ?? p.json;
  let body: string | null = null;
  if (rawBody !== undefined && rawBody !== null) {
    body = jsonPreview(redactValue(rawBody, b.acc), b.acc);
  } else {
    // No explicit body: preview whatever else the request carries (never the headers).
    const rest = Object.fromEntries(
      Object.entries(p).filter(([k]) => !['method', 'url', 'endpoint', 'headers'].includes(k)),
    );
    if (Object.keys(rest).length) body = jsonPreview(redactValue(rest, b.acc), b.acc);
  }
  return b.build('http', 'Outbound HTTP request', body);
}

function renderJson(payload: unknown, actionType: string): ApprovalContentView {
  const b = new Builder();
  return b.build('json', `Proposed ${actionType.replace(/_/g, ' ')} payload`, jsonPreview(redactValue(payload, b.acc), b.acc));
}

/**
 * Render an approval payload for owner review. `payload` is read from the stored approval row.
 * Credential-named keys are redacted BEFORE any per-type rendering, so a typed view can never
 * surface a secret field either.
 */
export function renderApprovalContent(actionType: string, payload: unknown): ApprovalContentView {
  const pre: Acc = { truncated: false, redacted: false };
  const clean = redactValue(payload, pre);
  const withPre = (v: ApprovalContentView): ApprovalContentView =>
    pre.redacted ? { ...v, redacted: true } : v;

  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return withPre(renderJson(clean, actionType));
  const p = clean as Record<string, unknown>;

  if (actionType === 'email_send') {
    return withPre(renderEmail(p, 'Email to send') ?? renderJson(p, actionType));
  }
  if (actionType === 'external_http') {
    if (p.kind === 'accuratebids_reply') {
      return withPre(renderEmail(p, 'Email reply to an AccurateBids inquiry (sent to the customer on approval)') ?? renderJson(p, actionType));
    }
    if (p.kind === 'accuratebids_quote') return withPre(renderQuoteOrInvoice(p, 'quote'));
    if (p.kind === 'accuratebids_invoice') return withPre(renderQuoteOrInvoice(p, 'invoice'));
    if (p.kind === 'accuratebids_send') return withPre(renderSend(p));
    return withPre(renderHttp(p));
  }
  return withPre(renderJson(p, actionType));
}
