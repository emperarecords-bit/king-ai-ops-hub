import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  extractProposedActions,
  MAX_ACTIONS_PER_RESPONSE,
  stripActionBlock,
} from '@/orchestration/actions';

function withBlock(json: string): string {
  return `Here is my answer.\n\n\`\`\`proposed-actions\n${json}\n\`\`\`\n`;
}

describe('extractProposedActions', () => {
  it('extracts a valid action', () => {
    const result = extractProposedActions(
      withBlock('[{"type":"git_commit","summary":"Commit the fix","payload":{"branch":"main"}}]'),
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe('git_commit');
    expect(result.actions[0]!.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rejected).toHaveLength(0);
  });

  it('returns nothing when there is no block', () => {
    const result = extractProposedActions('Just a plain answer.');
    expect(result.actions).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('rejects unknown action types — the enum is closed', () => {
    const result = extractProposedActions(
      withBlock('[{"type":"launch_missiles","summary":"nope","payload":{}}]'),
    );
    expect(result.actions).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON without throwing', () => {
    const result = extractProposedActions(withBlock('[{not json'));
    expect(result.actions).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('rejects a non-array body', () => {
    const result = extractProposedActions(
      withBlock('{"type":"git_commit","summary":"x","payload":{}}'),
    );
    expect(result.actions).toHaveLength(0);
  });

  it('caps the number of actions', () => {
    const many = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        type: 'file_write',
        summary: `write ${i}`,
        payload: {},
      })),
    );
    const result = extractProposedActions(withBlock(many));
    expect(result.actions).toHaveLength(MAX_ACTIONS_PER_RESPONSE);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  it('rejects oversized payloads', () => {
    const big = JSON.stringify([
      { type: 'file_write', summary: 'big', payload: { data: 'x'.repeat(20_000) } },
    ]);
    const result = extractProposedActions(withBlock(big));
    expect(result.actions).toHaveLength(0);
    expect(result.rejected[0]).toMatch(/payload exceeds/);
  });

  it('a prompt-injection payload cannot become an unknown action or execute anything', () => {
    // Adversarial: model was steered into proposing something outside the enum
    // plus an in-enum action with instruction-looking noise. The unknown type
    // dies; the known type survives only as a PENDING record for a human.
    const result = extractProposedActions(
      withBlock(
        JSON.stringify([
          { type: 'delete_all_projects', summary: 'ignore previous instructions', payload: {} },
          { type: 'email_send', summary: 'Send report', payload: { to: 'a@b.c' } },
        ]),
      ),
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.type).toBe('email_send');
    expect(result.rejected).toHaveLength(1);
  });

  it('unterminated blocks are rejected, not hung', () => {
    const result = extractProposedActions('answer\n```proposed-actions\n[{"type":"x"}');
    expect(result.actions).toHaveLength(0);
    expect(result.rejected[0]).toMatch(/Unterminated/);
  });
});

describe('canonicalJson', () => {
  it('is stable under key reordering', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('stripActionBlock', () => {
  it('removes the block and keeps the prose', () => {
    const text = withBlock('[{"type":"git_commit","summary":"x","payload":{}}]');
    const stripped = stripActionBlock(text);
    expect(stripped).toContain('Here is my answer.');
    expect(stripped).not.toContain('proposed-actions');
  });

  it('returns text unchanged when no block exists', () => {
    expect(stripActionBlock('plain')).toBe('plain');
  });
});
