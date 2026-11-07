// E2E: real claim-server.mjs process against two fake Solana JSON-RPCs (primary + confirm/fallback).
// No real keys (throwaway keypair in tmp), no network, no mainnet. Proves the mine-pool schedule ceiling
// runs in the live POST /api/claim path, fails closed, is chain-floored, and that other endpoints still work.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { LAUNCH_BASE, MAX_SUPPLY_BASE, RATE0 } from '../mine-rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agis-claim-e2e-'));
const GENESIS = Math.floor(Date.now() / 1000) - 100; // allowed ~= RATE0 * 100
const st = { supply: LAUNCH_BASE, primaryNoSupply: false, fallbackDown: false, calls: [] };

const fakeRpc = name => http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const one = j => {
      st.calls.push(name + ':' + j.method);
      const ctx = { slot: 1 };
      const supplyOk = name === 'primary' ? !st.primaryNoSupply : !st.fallbackDown;
      if (j.method === 'getTokenSupply' && supplyOk) return { jsonrpc: '2.0', id: j.id, result: { context: ctx, value: { amount: String(st.supply), decimals: 9, uiAmount: null, uiAmountString: String(st.supply / 10n ** 9n) } } };
      if (j.method === 'getSlot') return { jsonrpc: '2.0', id: j.id, result: 1 };
      if (j.method === 'getBalance') return { jsonrpc: '2.0', id: j.id, result: { context: ctx, value: 1_000_000_000 } };
      return { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: `fake ${name} rpc: ${j.method} disabled` } };
    };
    const j = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
  });
});
const primary = fakeRpc('primary'), fallback = fakeRpc('fallback');
let srv, port;
const freePort = () => new Promise(r => { const s = http.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const reset = () => { st.supply = LAUNCH_BASE; st.primaryNoSupply = false; st.fallbackDown = false; st.calls = []; };

test.before(async () => {
  await new Promise(r => primary.listen(0, '127.0.0.1', r));
  await new Promise(r => fallback.listen(0, '127.0.0.1', r));
  const kp = path.join(tmp, 'throwaway.json');
  fs.writeFileSync(kp, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  port = await freePort();
  const env = { ...process.env, MAINNET: '', SOLANA_RPC: `http://127.0.0.1:${primary.address().port}`, SOLANA_CONFIRM_RPC: `http://127.0.0.1:${fallback.address().port}`,
    SOLANA_KEYPAIR: kp, PORT: String(port), LEDGER: path.join(tmp, 'ledger.json'), RWA_DIR: path.join(tmp, 'rwa'), AGIS_GENESIS: String(GENESIS), REQUIRE_POV: '' };
  for (const k of ['SOLANA_KEYPAIR_JSON', 'MINT_AUTH_JSON', 'HELIUS_RPC', 'AEGIS_CARD_SIGNING_KEY', 'AGIS_MAX_SUPPLY', 'HOUSE_ECO_ENABLED']) delete env[k];
  srv = spawn(process.execPath, [path.join(here, '../claim-server.mjs')], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'], env });
  await new Promise((ok, bad) => { let o = ''; srv.stdout.on('data', d => { o += d; if (o.includes('claim server on')) ok(); }); srv.on('exit', c => bad(new Error('server exited ' + c))); setTimeout(() => bad(new Error('boot timeout')), 10000); });
});
test.after(() => { srv?.kill(); primary.close(); fallback.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function signedClaim() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const wallet = bs58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  const to = new Date(Date.now() - 1000), from = new Date(to.getTime() - 60e3);
  const msg = `AEGIS/mine-claim/v1|${wallet}|30|${from.toISOString()}|${to.toISOString()}|${crypto.randomUUID()}`;
  return { wallet, msg, sig: crypto.sign(null, Buffer.from(msg), privateKey).toString('base64') };
}
const api = p => `http://127.0.0.1:${port}${p}`;
const post = async c => (await fetch(api('/api/claim'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) })).json();
const get = async p => { const r = await fetch(api(p)); return { status: r.status, body: await r.json() }; };

test('inside schedule: gate passes and request reaches the mint step (fake RPC refuses mint)', async () => {
  reset();
  const r = await post(signedClaim());
  assert.equal(r.ok, false); assert.match(r.error, /^mint failed/);
  assert.ok(st.calls.includes('primary:getTokenSupply'), 'supply must be read before mint');
});
test('primary RPC rejects getTokenSupply (Allnodes case): falls back to confirm RPC, still gated', async () => {
  reset(); st.primaryNoSupply = true;
  const r = await post(signedClaim());
  assert.match(r.error, /^mint failed/);
  assert.ok(st.calls.includes('fallback:getTokenSupply'));
  st.supply = LAUNCH_BASE + RATE0 * 100_000n;
  assert.deepEqual(await post(signedClaim()), { ok: false, error: 'exceeds emission schedule' });
});
test('wiped ledger, chain already past schedule: refuses "exceeds emission schedule", no mint attempt', async () => {
  reset(); st.supply = LAUNCH_BASE + RATE0 * 100_000n;
  assert.deepEqual(await post(signedClaim()), { ok: false, error: 'exceeds emission schedule' });
  assert.ok(!st.calls.some(c => /getAccountInfo|sendTransaction|getBalance/.test(c)));
});
test('chain at max supply: refuses "exceeds max supply"', async () => {
  reset(); st.supply = MAX_SUPPLY_BASE;
  assert.deepEqual(await post(signedClaim()), { ok: false, error: 'exceeds max supply' });
});
test('no RPC can read supply: fails closed, no mint attempt', async () => {
  reset(); st.primaryNoSupply = true; st.fallbackDown = true;
  assert.deepEqual(await post(signedClaim()), { ok: false, error: 'supply check unavailable, try later' });
  assert.ok(!st.calls.some(c => /getAccountInfo|sendTransaction|getBalance/.test(c)));
});
test('GET /api/mine/schedule: public audit numbers + withinSchedule flag', async () => {
  reset(); st.supply = LAUNCH_BASE + RATE0 * 10n;
  let { status, body: s } = await get('/api/mine/schedule');
  assert.equal(status, 200); assert.equal(s.ok, true); assert.equal(s.era, 0); assert.equal(s.ratePerSecBase, String(RATE0));
  assert.equal(s.maxSupplyBase, String(MAX_SUPPLY_BASE)); assert.equal(s.launchBase, String(LAUNCH_BASE));
  assert.equal(s.chainMinedBase, String(RATE0 * 10n)); assert.equal(s.ledgerMinedBase, '0');
  assert.equal(s.withinSchedule, true); assert.ok(BigInt(s.headroomBase) > 0n);
  assert.ok(BigInt(s.emittedUntilBase) >= RATE0 * 100n);
  st.supply = LAUNCH_BASE + RATE0 * 100_000n;
  s = (await get('/api/mine/schedule')).body; assert.equal(s.withinSchedule, false); assert.equal(s.headroomBase, '0');
  st.primaryNoSupply = true; st.fallbackDown = true;
  s = (await get('/api/mine/schedule')).body; assert.equal(s.chainSupplyBase, null); assert.equal(s.withinSchedule, null); assert.match(s.note, /fail closed/);
});
test('existing endpoints still work: /api/health, /api/supply, /api/rwa/health', async () => {
  reset();
  const h = await get('/api/health'); assert.equal(h.status, 200); assert.equal(h.body.ok, true); assert.equal(h.body.mint, 'GhSiU95vtKwn7FBAW1u5krxYP2PnpFPotb1LJFZkbzhW');
  const s = await get('/api/supply'); assert.equal(s.status, 200); assert.equal(s.body.supply, String(LAUNCH_BASE));
  const r = await get('/api/rwa/health'); assert.equal(r.status, 200); assert.equal(r.body.rwa, true);
  assert.equal((await get('/api/nope')).status, 404);
});
test('failed claims leave no ledger debit or replay marker', () => {
  const l = fs.existsSync(path.join(tmp, 'ledger.json')) ? JSON.parse(fs.readFileSync(path.join(tmp, 'ledger.json'), 'utf8')) : { seen: {}, day: {} };
  assert.deepEqual(l.day, {}); assert.deepEqual(Object.values(l.seen).filter(v => v !== undefined), []);
});
test('AGIS_MAX_SUPPLY env is the single knob (e.g. 1B) and rejects garbage', () => {
  const run = v => execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./mine-rules.mjs'); console.log([m.MAX_SUPPLY_BASE, m.MINE_POOL_BASE, m.LAUNCH_BASE, m.RATE0].join(','))"],
    { cwd: path.join(here, '..'), env: { ...process.env, AGIS_MAX_SUPPLY: v }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const B = 10n ** 9n;
  assert.equal(run('1000000000'), [1_000_000_000n * B, 850_000_000n * B, 150_000_000n * B, 850_000_000n * B / 2n / 63072000n].join(','));
  assert.throws(() => run('abc')); assert.throws(() => run('0')); assert.throws(() => run('-5'));
});
