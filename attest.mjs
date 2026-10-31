// AGIS network attestation of a seal receipt (pov-r/seal-attest/1).
// This is NOT a government / eIDAS / notary signature. It is the AGIS claim server
// stating, with its Ed25519 key, which pinned fields it accepted for a seal.
// Key: env AEGIS_CARD_SIGNING_KEY = base58 of 32-byte seed or 64-byte tweetnacl secret. Never logged.
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export const ATTEST_ALG = 'pov-r/seal-attest/1';
export const FIELDS = ['alg', 'id', 'fingerprint', 'receiptTx', 'status', 'created', 'validUntil', 'anchoredBy', 'receiptAt'];

export function loadSigner(raw = process.env.AEGIS_CARD_SIGNING_KEY) {
  if (!raw) return null;
  const b = bs58.decode(raw.trim());
  const kp = b.length === 32 ? nacl.sign.keyPair.fromSeed(b) : b.length === 64 ? nacl.sign.keyPair.fromSecretKey(b) : null;
  if (!kp) throw new Error('AEGIS_CARD_SIGNING_KEY must be 32 or 64 bytes base58');
  return { publicKey: bs58.encode(kp.publicKey), sign: m => nacl.sign.detached(m, kp.secretKey) };
}

// Canonical message: fixed field order, one "k=v" per line, null -> empty.
export function attestMessage(j) {
  const o = { alg: ATTEST_ALG, id: j.id, fingerprint: j.fingerprint, receiptTx: j.receiptTx, status: j.status, created: j.created, validUntil: j.validUntil || null, anchoredBy: j.anchoredBy || null, receiptAt: j.receiptAt || null };
  return { fields: o, message: FIELDS.map(k => `${k}=${o[k] ?? ''}`).join('\n') };
}

export function attest(j, signer) {
  if (!j.receiptTx) return { status: 'pending', reason: 'no on-chain receipt yet' };
  if (!signer) return { status: 'unavailable', reason: 'server attestation key not configured' };
  const { fields, message } = attestMessage(j);
  return { status: 'signed', alg: ATTEST_ALG, keyAlg: 'ed25519', publicKey: signer.publicKey, fields, message, signature: bs58.encode(signer.sign(new TextEncoder().encode(message))), note: 'AGIS network attestation of the seal receipt. Not a government, eIDAS or notary signature.' };
}

export function verifyAttestation(a) {
  try { return nacl.sign.detached.verify(new TextEncoder().encode(a.message), bs58.decode(a.signature), bs58.decode(a.publicKey)) && attestMessage({ ...a.fields }).message === a.message; } catch { return false; }
}
