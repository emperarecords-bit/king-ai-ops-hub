import { UNREVIEWED_DRAFT_BANNER } from '@/orchestration/engine';
import { ARTIFACT_BLOCK_OPEN, extractRunArtifacts, type RunArtifact } from '@/orchestration/artifacts-block';

/**
 * How the task page's Answer tab shows a run's stored result (Hub prod 2026-10-22, server-cooling update run):
 * - the UNREVIEWED DRAFT banner is part of the stored text (it must travel with the answer everywhere else), but on
 *   the page the review-state badge directly above already says it — shown twice (three times with the review line),
 *   it read as noise. The page hides the banner ONLY when that badge is showing the unmet review.
 * - a deliverable saved as an ```artifact block was shown as a raw JSON blob. Each block that parses exactly as the
 *   engine parses it is lifted out and shown as a titled document; a block that does not parse stays in the text.
 *
 * Display only: the stored result, the email and every other reader are unchanged.
 */
export interface ResultView {
  /** The answer text to render (banner and lifted document blocks removed). */
  body: string;
  /** Deliverables found in the result, in order. */
  documents: RunArtifact[];
  bannerHidden: boolean;
}

export function splitResult(text: string, opts: { hideDraftBanner: boolean }): ResultView {
  let body = text;
  let bannerHidden = false;
  if (opts.hideDraftBanner && body.startsWith(UNREVIEWED_DRAFT_BANNER)) {
    body = body.slice(UNREVIEWED_DRAFT_BANNER.length).replace(/^\s+/, '');
    bannerHidden = true;
  }

  const documents: RunArtifact[] = [];
  let cursor = 0;
  for (;;) {
    const start = body.indexOf(ARTIFACT_BLOCK_OPEN, cursor);
    if (start === -1) break;
    const close = body.indexOf('```', start + ARTIFACT_BLOCK_OPEN.length);
    if (close === -1) break;
    const end = close + 3;
    const parsed = extractRunArtifacts(body.slice(start, end));
    if (parsed.artifacts.length === 1 && parsed.rejected.length === 0) {
      documents.push(parsed.artifacts[0]!);
      body = body.slice(0, start) + body.slice(end);
      cursor = start;
    } else {
      cursor = end;
    }
  }

  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), documents, bannerHidden };
}

/** A JSON document pretty-printed when it parses; otherwise as stored. */
export function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
