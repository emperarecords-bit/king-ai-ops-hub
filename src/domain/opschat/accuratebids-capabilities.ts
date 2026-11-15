import { sightEnabledKeys } from '@/domain/integrations/accuratebids-sight';
import { hasServiceToken } from '@/domain/integrations/accuratebids-tokens';

/**
 * What Ops Chat can do in AccurateBids RIGHT NOW, stated at the start of every turn.
 *
 * Why: capabilities change between releases, but a conversation's history does not. Seen live
 * (2026-10-19): before the owner-email send shipped, Ops Chat correctly said it could not add a
 * customer's email to an invoice; after it shipped, that old reply sat in the same conversation
 * and the model could repeat "not available" before discovering the capability a turn later via a
 * tool refusal. Stating the current capabilities up front — and that they supersede anything said
 * earlier in the conversation — lets the model act on the first turn.
 *
 * Derived only from configuration PRESENCE (never values), so it is exactly as current as the
 * deployed release. Returns null when no workspace is connected to AccurateBids.
 */
export function accurateBidsCapabilityContext(env: Record<string, string | undefined> = process.env): string | null {
  const keys = sightEnabledKeys(env);
  if (keys.length === 0) return null;
  // A workspace is connected only if it also holds a token it may use: each workspace reaches its
  // OWN AccurateBids account, and one listed without a token would otherwise look available here
  // and then be refused at execution — or silently bill another contractor. See accuratebids-tokens.ts.
  const connected = keys.filter((k) => hasServiceToken(k, env));
  const pending = keys.filter((k) => !hasServiceToken(k, env));
  const token = connected.length > 0;
  const on = (url: string | undefined) => (token && Boolean(url) ? 'AVAILABLE' : 'NOT CONFIGURED in this release');
  const send = on(env.ACCURATEBIDS_SEND_URL);
  const lines = [
    `=== ACCURATEBIDS CAPABILITIES (current release — authoritative for this turn) ===`,
    `Connected workspace key(s): ${connected.join(', ') || 'none yet'}. Each one acts as its own AccurateBids contractor account — never mix their records. Every action below is a confirm card; nothing happens until the owner clicks Confirm.`,
    `- Draft a quote (propose_accuratebids_quote): ${on(env.ACCURATEBIDS_QUOTE_URL)}.`,
    `- Create an invoice, from a quote or direct (propose_accuratebids_invoice): ${on(env.ACCURATEBIDS_INVOICE_URL)}.`,
    `- Email an invoice, a payment reminder, or a quote to the customer (propose_accuratebids_send): ${send}.`,
    // Same endpoint as drafting (hub-quote's `patch_contact` action), so it is gated on the same
    // URL. Presence of the URL cannot prove the deployed function is new enough to know the
    // action: against an older hub-quote it answers "unknown action", which surfaces as a blocked
    // card naming exactly that rather than a silent no-op. Live in AccurateBids prod since v7.
    `- Correct the customer's email/phone on an existing DRAFT quote (propose_accuratebids_contact_patch): ${on(env.ACCURATEBIDS_QUOTE_URL)}. It OVERWRITES what is on the quote and you cannot see the current value, so say what it is being set TO and never claim what it was. Emails nothing. Draft quotes only.`,
  ];
  if (send === 'AVAILABLE') {
    lines.push(
      `  - Invoice with NO email on file (has_email false): SUPPORTED. Take the customer's address from the owner, from one they already typed in this chat, or from a document they uploaded here (say which file - the card shows the address either way); ask only if none of those has it. Pass it as customer_email — on Confirm it is saved to that invoice and the invoice is emailed. An address already on file is never replaced by a SEND. To change the address on a DRAFT QUOTE (replacing one, or adding a missing one), use propose_accuratebids_contact_patch — that is a correction card of its own and it emails nothing.`,
    );
  }
  if (pending.length > 0) {
    lines.push(
      `Listed but NOT connected yet: ${pending.join(', ')}. Their AccurateBids account is not wired to this server, so quotes, invoices and sends for them would be refused. Say that plainly if asked — do not route their work through a connected workspace.`,
    );
  }
  lines.push(
    `These capabilities can change between releases. If anything earlier in this conversation said one of them was unavailable or impossible, that is out of date — act on this list instead of repeating it.`,
  );
  return lines.join('\n');
}
