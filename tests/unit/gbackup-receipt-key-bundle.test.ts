import { type KeyObject, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';

const pem = (pub: KeyObject) => pub.export({ type: 'spki', format: 'pem' }).toString();
const kp = generateKeyPairSync('ed25519');
const kp2 = generateKeyPairSync('ed25519');
const base = () => ({ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: pem(kp.publicKey), purpose: 'deployment_backup_receipt', status: 'active' });

describe('G-Backup-B1 receipt-key bundle policy (purpose deployment_backup_receipt)', () => {
  it('accepts a correct receipt-purpose key', () => {
    const r = loadReceiptKeyBundle([base()]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.store.keyring.has('test-dbr-001')).toBe(true);
  });
  it('rejects a legacy_migration_attestation purpose key', () => {
    expect(loadReceiptKeyBundle([{ ...base(), purpose: 'legacy_migration_attestation' }]).ok).toBe(false);
  });
  it('rejects a wrong algorithm', () => {
    expect(loadReceiptKeyBundle([{ ...base(), algorithm: 'rsa' }]).ok).toBe(false);
  });
  it('a revoked key is not active', () => {
    const r = loadReceiptKeyBundle([{ ...base(), status: 'revoked' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.store.revoked.has('test-dbr-001')).toBe(true);
      expect(r.store.keyring.has('test-dbr-001')).toBe(false);
    }
  });
  it('rejects a duplicate keyId', () => {
    expect(loadReceiptKeyBundle([base(), base()]).ok).toBe(false);
  });
  it('rejects the same public key under a second (unauthorized) id', () => {
    expect(loadReceiptKeyBundle([base(), { ...base(), keyId: 'test-dbr-002' }]).ok).toBe(false);
  });
  it('rejects a same id both active and revoked', () => {
    expect(loadReceiptKeyBundle([base(), { ...base(), status: 'revoked' }]).ok).toBe(false);
  });
  it('accepts optional notBefore/notAfter and carries them; two distinct keys are fine', () => {
    const r = loadReceiptKeyBundle([
      { ...base(), notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' },
      { keyId: 'test-dbr-002', algorithm: 'ed25519', publicKeyPem: pem(kp2.publicKey), purpose: 'deployment_backup_receipt', status: 'active' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.store.keyring.get('test-dbr-001')!.notBefore).not.toBeNull();
      expect(r.store.keyring.has('test-dbr-002')).toBe(true);
    }
  });
});
