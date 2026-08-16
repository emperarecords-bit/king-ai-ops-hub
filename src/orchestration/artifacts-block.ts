import { z } from 'zod';

/**
 * Run-produced artifacts (TB-4 sibling of actions.ts / delegations.ts). ANY employee's run may end
 * with an `artifact` block; each valid entry is saved as a workspace Artifact at finalization —
 * an internal, reversible, audited record (a deliverable on the shelf, not an external action).
 * Malformed entries are reported, never repaired, and never fail the run.
 */

export const ARTIFACT_BLOCK_OPEN = '```artifact';
export const MAX_ARTIFACTS_PER_RUN = 3;
export const MAX_ARTIFACT_CHARS = 60_000;

const runArtifactSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['text', 'markdown', 'json']),
    content: z.string().min(1).max(MAX_ARTIFACT_CHARS),
  })
  .strict();

export interface RunArtifact {
  readonly name: string;
  readonly kind: 'text' | 'markdown' | 'json';
  readonly content: string;
}

export interface ArtifactExtraction {
  readonly artifacts: readonly RunArtifact[];
  readonly rejected: readonly string[];
}

/**
 * Every ```artifact fence in the reply is parsed (unlike actions/delegations, multiple blocks are
 * natural here: one per deliverable). Each block holds ONE JSON object.
 */
export function extractRunArtifacts(modelText: string): ArtifactExtraction {
  const rejected: string[] = [];
  const artifacts: RunArtifact[] = [];
  let cursor = 0;
  let blockIndex = 0;
  while (artifacts.length < MAX_ARTIFACTS_PER_RUN) {
    const fenceStart = modelText.indexOf(ARTIFACT_BLOCK_OPEN, cursor);
    if (fenceStart === -1) break;
    const afterFence = modelText.slice(fenceStart + ARTIFACT_BLOCK_OPEN.length);
    const fenceEnd = afterFence.indexOf('```');
    if (fenceEnd === -1) {
      rejected.push('Unterminated artifact block.');
      break;
    }
    cursor = fenceStart + ARTIFACT_BLOCK_OPEN.length + fenceEnd + 3;
    const raw = afterFence.slice(0, fenceEnd).trim();
    blockIndex += 1;
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rejected.push(`Artifact block ${blockIndex} is not valid JSON.`);
      continue;
    }
    const result = runArtifactSchema.safeParse(parsed);
    if (!result.success) {
      rejected.push(`Artifact block ${blockIndex} rejected: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    artifacts.push(result.data);
  }
  return { artifacts, rejected };
}

/** Appended to EVERY employee's system prompt: deliverables belong on the shelf, not buried in chat. */
export const ARTIFACT_RULES = `
- When your reply's real product is a DELIVERABLE the team will reuse (a brief, plan, schedule, script, spec, checklist, report), ALSO save it as an artifact by ending your reply with a fenced block per deliverable (at most ${MAX_ARTIFACTS_PER_RUN}):
${ARTIFACT_BLOCK_OPEN}
{"name": "<short document name>", "kind": "markdown", "content": "<the COMPLETE deliverable>"}
\`\`\`
  Artifacts are saved to the workspace shelf automatically. Conversational replies need no artifact.`;
