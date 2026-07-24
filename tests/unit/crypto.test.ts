import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_GENESIS,
  auditRowHash,
  decryptSecret,
  encryptSecret,
  lastFour,
  parseKeyVersion,
} from '@/lib/crypto';

const key = randomBytes(32);

describe('secret encryption', () => {
  it('round-trips', () => {
    const { serialized } = encryptSecret('sk-super-secret-value', key, 1);
    expect(decryptSecret(serialized, key)).toBe('sk-super-secret-value');
  });

  it('produces a distinct IV every time', () => {
    const a = encryptSecret('same-input', key, 1).serialized;
    const b = encryptSecret('same-input', key, 1).serialized;
    expect(a).not.toBe(b);
  });

  it('detects ciphertext tampering (GCM auth)', () => {
    const { serialized } = encryptSecret('payload', key, 1);
    const parts = serialized.split('.');
    // Flip a character in the ciphertext segment.
    const ct = parts[3]!;
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });

  it('refuses the wrong key', () => {
    const { serialized } = encryptSecret('payload', key, 1);
    expect(() => decryptSecret(serialized, randomBytes(32))).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => encryptSecret('x', randomBytes(16), 1)).toThrow();
  });

  it('parses the key version for rotation', () => {
    const { serialized } = encryptSecret('x', key, 3);
    expect(parseKeyVersion(serialized)).toBe(3);
    expect(() => parseKeyVersion('garbage')).toThrow();
  });
});

describe('lastFour', () => {
  it('shows only the tail', () => {
    expect(lastFour('sk-abcdef1234')).toBe('1234');
    expect(lastFour('ab')).toBe('****');
  });
});

describe('audit hash chain', () => {
  const base = {
    orgId: 'org-1',
    actorId: 'user-1',
    action: 'task.created',
    entityType: 'task',
    entityId: 'task-1',
    detailJson: '{"a":1}',
    createdAtIso: '2026-07-23T00:00:00.000Z',
  };

  it('is deterministic', () => {
    const h1 = auditRowHash({ ...base, prevHash: AUDIT_CHAIN_GENESIS });
    const h2 = auditRowHash({ ...base, prevHash: AUDIT_CHAIN_GENESIS });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('any field change breaks the hash', () => {
    const h1 = auditRowHash({ ...base, prevHash: AUDIT_CHAIN_GENESIS });
    const h2 = auditRowHash({ ...base, prevHash: AUDIT_CHAIN_GENESIS, action: 'task.deleted' });
    expect(h1).not.toBe(h2);
  });

  it('chains: a different prev hash yields a different row hash', () => {
    const h1 = auditRowHash({ ...base, prevHash: AUDIT_CHAIN_GENESIS });
    const h2 = auditRowHash({ ...base, prevHash: h1 });
    expect(h1).not.toBe(h2);
  });
});
