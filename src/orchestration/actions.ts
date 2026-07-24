import { z } from 'zod';
import { ACTION_TYPES, type ActionType } from '@/types/domain';
import { sha256Hex } from '@/lib/crypto';
import { ACTION_BLOCK_OPEN } from './prompts';

/**
 * Extraction of proposed actions from model output. This is trust boundary
 * TB-4: everything here is hostile until it survives the Zod parse. Failures
 * are reported, not thrown — a model emitting garbage must not fail the run,
 * it must produce an auditable "malformed output" note.
 */

export const MAX_ACTIONS_PER_RESPONSE = 5;
const MAX_SUMMARY_LENGTH = 500;
const MAX_PAYLOAD_BYTES = 16_384;

const proposedActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export interface ProposedAction {
  readonly type: ActionType;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  /** sha256 of canonical payload JSON; the executor re-verifies before acting. */
  readonly payloadSha256: string;
}

export interface ActionExtraction {
  readonly actions: readonly ProposedAction[];
  /** Human-readable reasons anything was discarded. Audited by the engine. */
  readonly rejected: readonly string[];
}

/** Canonical JSON: stable key order, so the payload hash is deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function extractProposedActions(modelText: string): ActionExtraction {
  const rejected: string[] = [];

  const fenceStart = modelText.lastIndexOf(ACTION_BLOCK_OPEN);
  if (fenceStart === -1) return { actions: [], rejected };

  const afterFence = modelText.slice(fenceStart + ACTION_BLOCK_OPEN.length);
  const fenceEnd = afterFence.indexOf('```');
  if (fenceEnd === -1) {
    rejected.push('Unterminated proposed-actions block.');
    return { actions: [], rejected };
  }

  const raw = afterFence.slice(0, fenceEnd).trim();
  if (raw.length === 0) return { actions: [], rejected };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    rejected.push('proposed-actions block is not valid JSON.');
    return { actions: [], rejected };
  }

  if (!Array.isArray(parsed)) {
    rejected.push('proposed-actions block must be a JSON array.');
    return { actions: [], rejected };
  }

  if (parsed.length > MAX_ACTIONS_PER_RESPONSE) {
    rejected.push(
      `Model proposed ${parsed.length} actions; only the first ${MAX_ACTIONS_PER_RESPONSE} were considered.`,
    );
  }

  const actions: ProposedAction[] = [];
  for (const [index, candidate] of parsed.slice(0, MAX_ACTIONS_PER_RESPONSE).entries()) {
    const result = proposedActionSchema.safeParse(candidate);
    if (!result.success) {
      rejected.push(
        `Action ${index} rejected: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    const canonical = canonicalJson(result.data.payload);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) {
      rejected.push(`Action ${index} rejected: payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
      continue;
    }
    actions.push({
      type: result.data.type,
      summary: result.data.summary,
      payload: result.data.payload,
      payloadSha256: sha256Hex(canonical),
    });
  }

  return { actions, rejected };
}

/** The response body with the action block removed, for display. */
export function stripActionBlock(modelText: string): string {
  const fenceStart = modelText.lastIndexOf(ACTION_BLOCK_OPEN);
  if (fenceStart === -1) return modelText.trim();
  const afterFence = modelText.slice(fenceStart + ACTION_BLOCK_OPEN.length);
  const fenceEnd = afterFence.indexOf('```');
  if (fenceEnd === -1) return modelText.trim();
  return (
    modelText.slice(0, fenceStart) + afterFence.slice(fenceEnd + 3)
  ).trim();
}
