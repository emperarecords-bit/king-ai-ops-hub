# King Voice Line

Call a phone number; talk to the company. Twilio ConversationRelay handles speech both ways;
this service runs the brain (Anthropic) whose only hands are the hub's MCP API.

## Security (all fail-closed)
1. Twilio signature validation on every webhook.
2. Caller-ID allowlist (`OWNER_PHONE_NUMBERS`).
3. Keypad PIN (`VOICE_PIN`) before the AI connects.
4. The AI holds only the `claude-voice-partner` hub token — everything it can do is governed by
   the hub (budgeted runs; consequential actions still require Inbox approval).

## Secrets (fly secrets set -a king-ai-ops-hub-voice ...)
- `ANTHROPIC_API_KEY` — the brain.
- `TWILIO_AUTH_TOKEN` — webhook signature validation (from the Twilio console).
- `HUB_MCP_TOKEN` — the claude-voice-partner token.
- `OWNER_PHONE_NUMBERS` — comma-separated E.164 (e.g. `+15551234567`).
- `VOICE_PIN` — 4–8 digits, owner-chosen.

## Twilio setup (owner)
1. Create/upgrade a Twilio account; complete **Voice → ConversationRelay onboarding**.
2. Buy a voice-capable number.
3. Set the number's Voice webhook to `https://king-ai-ops-hub-voice.fly.dev/voice` (HTTP POST).

## Deploy
`fly deploy` from this directory. Stateless; scales to zero when idle.
