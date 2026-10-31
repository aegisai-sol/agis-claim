// PoV-R work proof for mining claims (pure; no keys, no RPC).
// The server hands a wallet a batch of small verification tasks (true/false statements).
// Tasks are regenerated from an HMAC of the batch id, so the server stores nothing until claim.
// The miner must actually check each statement (multiply, hash, primality); guessing scores ~50%.
// At claim time the server re-derives the tasks, grades the answer bits, and only CORRECT
// answers become work units. Below MIN_ACCURACY the claim is rejected.
import crypto from 'node:crypto';

export const POV_DOMAIN = 'AEGIS/pov-batch/v1';
export const MAX_TASKS = 120;
export const MIN_ACCURACY = 0.9;
export const BATCH_TTL_SEC = 24 * 3600;

const mac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function issueBatch(secret, wallet, n, iatSec, nonceHex) {
  if (!(Number.isInteger(n) && n >= 1 && n <= MAX_TASKS)) throw new Error('bad task count');
  if (!/^[0-9a-f]{16}$/.test(nonceHex)) throw new Error('bad nonce');
  const tag = mac(secret, `${POV_DOMAIN}|${wallet}|${iatSec}|${nonceHex}|${n}`).subarray(0, 16).toString('hex');
  const batchId = `${iatSec}.${nonceHex}.${n}.${tag}`;
  return { batchId, tasks: deriveTasks(secret, batchId).map(t => t.text) };
}

export function parseBatch(secret, wallet, batchId, nowSec) {
  const m = /^(\d{9,11})\.([0-9a-f]{16})\.(\d{1,3})\.([0-9a-f]{32})$/.exec(String(batchId || ''));
  if (!m) throw new Error('bad batch');
  const iat = Number(m[1]), n = Number(m[3]);
  if (!(n >= 1 && n <= MAX_TASKS)) throw new Error('bad batch');
  const want = mac(secret, `${POV_DOMAIN}|${wallet}|${iat}|${m[2]}|${n}`).subarray(0, 16);
  const got = Buffer.from(m[4], 'hex');
  if (!crypto.timingSafeEqual(want, got)) throw new Error('batch not issued to this wallet');
  if (iat > nowSec + 120 || nowSec - iat > BATCH_TTL_SEC) throw new Error('batch expired');
  return { iat, n, tag: m[4] };
}

function isPrime(x) { if (x < 2) return false; for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; }

// Deterministic task list for a batch. Each task: { text, truth }.
export function deriveTasks(secret, batchId) {
  const n = Number(String(batchId).split('.')[2]);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = mac(secret, `${POV_DOMAIN}|task|${batchId}|${i}`);
    const kind = r[0] % 3, flip = (r[1] & 1) === 1;
    if (kind === 0) {
      const a = 100 + r.readUInt16BE(2) % 900, b = 100 + r.readUInt16BE(4) % 900, d = 1 + r[6] % 9;
      const c = a * b + (flip ? 0 : (r[7] & 1 ? d : -d));
      out.push({ text: `${a}*${b}=${c}`, truth: flip });
    } else if (kind === 1) {
      const s = 'agis:' + r.subarray(8, 14).toString('hex'), h = sha(s).slice(0, 2);
      const p = flip ? h : ((parseInt(h, 16) + 1 + r[14] % 254) % 256).toString(16).padStart(2, '0');
      out.push({ text: `sha256(${s})^${p}`, truth: flip });
    } else {
      const x = 1001 + r.readUInt16BE(16) % 60000;
      out.push({ text: `prime(${x})`, truth: isPrime(x) });
    }
  }
  return out;
}

// Reference solver (what an honest miner runs). Same rules the browser miner uses.
export function solveTask(text) {
  let m;
  if ((m = /^(\d+)\*(\d+)=(-?\d+)$/.exec(text))) return Number(m[1]) * Number(m[2]) === Number(m[3]);
  if ((m = /^sha256\((agis:[0-9a-f]+)\)\^([0-9a-f]{2})$/.exec(text))) return sha(m[1]).startsWith(m[2]);
  if ((m = /^prime\((\d+)\)$/.exec(text))) return isPrime(Number(m[1]));
  throw new Error('unknown task');
}

// answers: hex string of bits, bit i (MSB-first) = miner's verdict for task i.
export function encodeAnswers(bools) {
  const bytes = Buffer.alloc(Math.ceil(bools.length / 8));
  bools.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
  return bytes.toString('hex');
}
export function gradeAnswers(secret, batchId, answersHex) {
  const tasks = deriveTasks(secret, batchId), n = tasks.length;
  if (!/^[0-9a-f]*$/.test(String(answersHex)) || answersHex.length !== Math.ceil(n / 8) * 2) throw new Error('bad answers');
  const bytes = Buffer.from(answersHex, 'hex');
  let correct = 0;
  tasks.forEach((t, i) => { if (((bytes[i >> 3] & (0x80 >> (i & 7))) !== 0) === t.truth) correct++; });
  const accuracy = correct / n;
  return { n, correct, accuracy, pass: accuracy >= MIN_ACCURACY };
}
