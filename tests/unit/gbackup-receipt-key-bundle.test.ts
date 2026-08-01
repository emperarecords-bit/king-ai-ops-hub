import { type KeyObject, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ReceiptKeyLoadFailCode, loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';

const pem = (pub: KeyObject) => pub.export({ type: 'spki', format: 'pem' }).toString();
const kp = generateKeyPairSync('ed25519');
const kp2 = generateKeyPairSync('ed25519');
const base = () => ({ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: pem(kp.publicKey), purpose: 'deployment_backup_receipt', status: 'active' });
const codeOf = (entries: unknown[]): ReceiptKeyLoadFailCode | 'OK' => { const r = loadReceiptKeyBundle(entries); return r.ok ? 'OK' : r.code; };

describe('G-Backup-B1 receipt-key bundle policy (purpose deployment_backup_receipt)', () => {
  it('accepts a correct receipt-purpose key', () => {
    const r = loadReceiptKeyBundle([base()]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.store.keyring.has('test-dbr-001')).toBe(true);
  });
  it('a revoked key is not active', () => {
    const r = loadReceiptKeyBundle([{ ...base(), status: 'revoked' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.store.revoked.has('test-dbr-001')).toBe(true);
      expect(r.store.keyring.has('test-dbr-001')).toBe(false);
    }
  });
  it('an inactive key is retained as inactive, not active', () => {
    const r = loadReceiptKeyBundle([{ ...base(), status: 'inactive' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.store.inactive.has('test-dbr-001')).toBe(true);
      expect(r.store.keyring.has('test-dbr-001')).toBe(false);
    }
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

describe('G-Backup-B1 receipt-key STRUCTURED failure taxonomy (load-time)', () => {
  it('schema_invalid: malformed entry (missing required field / unknown key)', () => {
    expect(codeOf([{ keyId: 'x', algorithm: 'ed25519', purpose: 'deployment_backup_receipt', status: 'active' }])).toBe('schema_invalid'); // no publicKeyPem
    expect(codeOf([{ ...base(), extra: 1 }])).toBe('schema_invalid'); // strict: unknown property
  });
  it('wrong_key_purpose: legacy_migration_attestation purpose rejected distinctly', () => {
    expect(codeOf([{ ...base(), purpose: 'legacy_migration_attestation' }])).toBe('wrong_key_purpose');
  });
  it('wrong_key_algorithm: declared algorithm other than ed25519', () => {
    expect(codeOf([{ ...base(), algorithm: 'rsa' }])).toBe('wrong_key_algorithm');
  });
  it('wrong_key_type: declared ed25519 but the actual public key is a different type', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(codeOf([{ ...base(), publicKeyPem: pem(rsa.publicKey) }])).toBe('wrong_key_type');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(codeOf([{ ...base(), publicKeyPem: pem(ec.publicKey) }])).toBe('wrong_key_type');
  });
  it('malformed_public_key: unparseable PEM', () => {
    expect(codeOf([{ ...base(), publicKeyPem: '-----BEGIN PUBLIC KEY-----\nnotbase64\n-----END PUBLIC KEY-----\n' }])).toBe('malformed_public_key');
  });
  it('duplicate_key_id: same keyId twice', () => {
    expect(codeOf([base(), base()])).toBe('duplicate_key_id');
    expect(codeOf([base(), { ...base(), status: 'revoked' }])).toBe('duplicate_key_id'); // same id, active + revoked
  });
  it('duplicate_key_fingerprint: same public key under a second (unauthorized) id — by DER-SPKI fingerprint, not PEM text', () => {
    expect(codeOf([base(), { ...base(), keyId: 'test-dbr-002' }])).toBe('duplicate_key_fingerprint');
    const canonicalPem = pem(kp.publicKey);
    const crlfVariant = canonicalPem.replace(/\n/g, '\r\n') + '   \n'; // same DER, different bytes
    expect(canonicalPem).not.toBe(crlfVariant);
    expect(codeOf([base(), { ...base(), keyId: 'test-dbr-999', publicKeyPem: crlfVariant }])).toBe('duplicate_key_fingerprint');
  });
  it('invalid_validity_window: notBefore >= notAfter', () => {
    expect(codeOf([{ ...base(), notBefore: '2027-01-01T00:00:00.000Z', notAfter: '2026-01-01T00:00:00.000Z' }])).toBe('invalid_validity_window');
    expect(codeOf([{ ...base(), notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2026-01-01T00:00:00.000Z' }])).toBe('invalid_validity_window');
  });
});

describe('G-Backup-B1 private-key material is rejected for EVERY PEM spelling (before any public key can be derived)', () => {
  // Ephemeral in-memory keys only; no fixed/operational key material.
  const ed = generateKeyPairSync('ed25519');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cases: Array<{ label: string; pem: string }> = [
    { label: 'PKCS#8 (BEGIN PRIVATE KEY)', pem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    { label: 'Encrypted PKCS#8 (BEGIN ENCRYPTED PRIVATE KEY)', pem: ed.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }).toString() },
    { label: 'PKCS#1 RSA (BEGIN RSA PRIVATE KEY)', pem: rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() },
    { label: 'SEC1 EC (BEGIN EC PRIVATE KEY)', pem: ec.privateKey.export({ type: 'sec1', format: 'pem' }).toString() },
    // Node's KeyObject cannot export OpenSSH private keys, but the loader rejects on the banner substring before
    // any parse, so a well-formed OpenSSH banner is sufficient to prove the container is refused pre-derivation.
    { label: 'OpenSSH (BEGIN OPENSSH PRIVATE KEY)', pem: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n' },
  ];
  for (const c of cases) {
    it(`rejects ${c.label} with private_key_material_rejected`, () => {
      expect(c.pem).toContain('PRIVATE KEY');
      expect(codeOf([{ ...base(), publicKeyPem: c.pem }])).toBe('private_key_material_rejected');
    });
  }
  it('never leaks PEM contents in the failure result', () => {
    const r = loadReceiptKeyBundle([{ ...base(), publicKeyPem: cases[0]!.pem }]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
  });
});

describe('G-Backup-B1 receipt-key diagnostics never carry PEM', () => {
  it('emits DER length + fingerprint, no key text', () => {
    const r = loadReceiptKeyBundle([base()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.store.diagnostics.find((x) => x.keyId === 'test-dbr-001')!;
      expect(d.derSpkiByteLength).toBe(44);
      expect(d.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.purpose).toBe('deployment_backup_receipt');
      expect(JSON.stringify(d)).not.toContain('PUBLIC KEY');
    }
  });
});
