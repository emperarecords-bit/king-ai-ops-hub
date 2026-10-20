import { sightEnabledKeys } from '@/domain/integrations/accuratebids-sight';

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
  const token = Boolean(env.ACCURATEBIDS_SERVICE_TOKEN);
  const on = (url: string | undefined) => (token && Boolean(url) ? 'AVAILABLE' : 'NOT CONFIGURED in this release');
  const send = on(env.ACCURATEBIDS_SEND_URL);
  const lines = [
    `=== ACCURATEBIDS CAPABILITIES (current release — authoritative for this turn) ===`,
    `Connected workspace key(s): ${keys.join(', ')}. Every action below is a confirm card; nothing happens until the owner clicks Confirm.`,
    `- Draft a quote (propose_accuratebids_quote): ${on(env.ACCURATEBIDS_QUOTE_URL)}.`,
    `- Create an invoice, from a quote or direct (propose_accuratebids_invoice): ${on(env.ACCURATEBIDS_INVOICE_URL)}.`,
    `- Email an invoice, a payment reminder, or a quote to the customer (propose_accuratebids_send): ${send}.`,
  ];
  if (send === 'AVAILABLE') {
    lines.push(
      `  - Invoice with NO email on file (has_email false): SUPPORTED. Ask the owner for the customer's address (or use one they already typed to you in this chat) and pass it as customer_email — on Confirm it is saved to that invoice and the invoice is emailed. An address already on file is never replaced; a quote's email must be added in AccurateBids.`,
    );
  }
  lines.push(
    `These capabilities can change between releases. If anything earlier in this conversation said one of them was unavailable or impossible, that is out of date — act on this list instead of repeating it.`,
  );
  return lines.join('\n');
}
