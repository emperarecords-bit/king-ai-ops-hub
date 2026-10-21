/**
 * P5b-1 — where an Ops Chat run notification points. Pure (no DB, no env read) so the privacy rule is unit-tested:
 * the deep link to the originating card (`/ops?c=<conversation>#card-<proposal>`) is used ONLY when the
 * notification's recipient IS the card's owner — Ops Chat conversations are owner-private, so any other recipient
 * (e.g. an org owner who is not the person who confirmed the card) gets the task link instead and never learns the
 * conversation id. Absolute when APP_URL is a valid http(s) origin; otherwise the path alone.
 */

export interface OpsChatRunLink {
  readonly proposalId: string;
  /** The card's conversation, when it was readable at finalize (card owner's own RLS); else null. */
  readonly conversationId: string | null;
  readonly cardOwnerUserId: string | null;
  /** `/p/<projectKey>/tasks/<taskId>` — always safe for a workspace member. */
  readonly taskPath: string;
}

function absolute(path: string, appUrl: string | undefined): string {
  if (!appUrl) return path;
  try {
    const base = new URL(appUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return path;
    return new URL(path, base.origin).toString();
  } catch {
    return path;
  }
}

export function opsChatLinkTarget(link: OpsChatRunLink, recipientUserId: string): { kind: 'card' | 'task'; path: string } {
  if (link.conversationId && link.cardOwnerUserId && link.cardOwnerUserId === recipientUserId) {
    return { kind: 'card', path: `/ops?c=${encodeURIComponent(link.conversationId)}#card-${encodeURIComponent(link.proposalId)}` };
  }
  return { kind: 'task', path: link.taskPath };
}

/** The line appended to the notification body. */
export function opsChatLinkLine(link: OpsChatRunLink, recipientUserId: string, appUrl: string | undefined): string {
  const t = opsChatLinkTarget(link, recipientUserId);
  const url = absolute(t.path, appUrl);
  return t.kind === 'card' ? `Open it in Ops Chat: ${url}` : `Open the task: ${url}`;
}
