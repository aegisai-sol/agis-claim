import test from 'node:test';
import assert from 'node:assert/strict';
import { eraOf, difficultyBps, computeClaim, RATE0, ERA } from '../mine-rules.mjs';
const G = 1_800_000_000, CAP = 100n * 10n ** 9n, GCAP = 100000n * 10n ** 9n;
const base = (o = {}) => computeClaim({ tasks: 10, fromSec: G + 5, genesisSec: G, unitBps: 1, wallet: 'W', day: 'D', ledgerDay: {}, dayWallets: [], dailyCap: CAP, globalCap: GCAP, ...o });

test('era halves every ~2y and never negative', () => {
  assert.equal(eraOf(G - 10, G), 0);
  assert.equal(eraOf(G + ERA - 1, G), 0);
  assert.equal(eraOf(G + ERA, G), 1);
  const a = base(), b = base({ fromSec: G + ERA + 5 });
  assert.equal(b.amount * 2n <= a.amount && a.amount - b.amount * 2n <= 10n, true);
});
test('full reward up to 100 wallets, then shared', () => {
  assert.equal(difficultyBps(0), 10000n);
  assert.equal(difficultyBps(100), 10000n);
  assert.equal(difficultyBps(200), 5000n);
  assert.throws(() => difficultyBps(-1));
  const many = Array.from({ length: 199 }, (_, i) => 'x' + i);
  const r = base({ dayWallets: many });
  assert.equal(r.active, 200); assert.equal(r.difficultyBps, 5000);
  assert.equal(r.amount, (RATE0 * 10n / 10000n) * 5000n / 10000n);
});
test('same wallet again does not raise difficulty', () => {
  const r = base({ dayWallets: Array.from({ length: 100 }, (_, i) => i ? 'x' + i : 'W') });
  assert.equal(r.active, 100); assert.equal(r.difficultyBps, 10000);
});
test('per-wallet cap clips then fails closed', () => {
  const r = base({ tasks: 100_000_000, ledgerDay: { 'D|W': String(CAP - 5n) } });
  assert.equal(r.ok, true); assert.equal(r.amount, 5n);
  const f = base({ ledgerDay: { 'D|W': String(CAP) } });
  assert.equal(f.ok, false); assert.equal(f.error, 'daily cap reached');
});
test('global cap clips', () => {
  const r = base({ tasks: 100_000_000, ledgerDay: { 'D|*': String(GCAP - 7n) } });
  assert.equal(r.amount, 7n);
});
test('era far future mints nothing', () => {
  assert.equal(base({ fromSec: G + ERA * 300 }).ok, false);
});

// ---- schedule ceiling (85% pool + halving + max supply, chain-floored) ----
import V from './emission-vectors.mjs';
import { emittedUntil, minedFromLedger, scheduleGate, MINE_POOL_BASE, MAX_SUPPLY_BASE, MAX_SUPPLY_AGIS, LAUNCH_BASE } from '../mine-rules.mjs';
const gate = (o = {}) => scheduleGate({ amount: 5n * 10n ** 9n, ledgerMined: 0n, chainSupply: LAUNCH_BASE, nowSec: G + 3600, genesisSec: G, ...o });

test('supply constants: single 10B knob, 85% pool, 15% launch, RATE0 = pool/2/era', () => {
  assert.equal(MAX_SUPPLY_AGIS, 10_000_000_000n);
  assert.equal(MAX_SUPPLY_BASE, 10_000_000_000n * 10n ** 9n);
  assert.equal(MINE_POOL_BASE, 8_500_000_000n * 10n ** 9n);
  assert.equal(LAUNCH_BASE, 1_500_000_000n * 10n ** 9n);
  assert.equal(MINE_POOL_BASE + LAUNCH_BASE, MAX_SUPPLY_BASE);
  assert.equal(String(RATE0), V.rate0); assert.equal(String(MINE_POOL_BASE), V.minePoolBase); assert.equal(ERA, V.eraSeconds);
});
test('emittedUntil: shared vectors (Python mine_emit agrees), monotonic, < 85% pool forever', () => {
  assert.ok(V.cases.length >= 15);
  for (const c of V.cases) assert.equal(String(emittedUntil(V.genesis + c.offset, V.genesis)), c.emittedUntil, 'offset ' + c.offset);
  let prev = -1n;
  for (const c of V.cases) { const x = BigInt(c.emittedUntil); assert.ok(x >= prev); prev = x; }
  assert.ok(emittedUntil(G + ERA * 1000, G) < MINE_POOL_BASE);
  assert.equal(emittedUntil(G - 50, G), 0n);
  assert.equal(emittedUntil(G + 10, G), RATE0 * 10n);
});
test('halving boundaries: last second of era 0, first seconds of era 1 and 2', () => {
  const e0 = RATE0 * BigInt(ERA);
  assert.equal(emittedUntil(G + ERA - 1, G), RATE0 * BigInt(ERA - 1));
  assert.equal(emittedUntil(G + ERA, G), e0);
  assert.equal(emittedUntil(G + ERA + 1, G) - e0, RATE0 >> 1n);          // rate halves at the boundary
  const e1 = e0 + (RATE0 >> 1n) * BigInt(ERA);
  assert.equal(emittedUntil(G + 2 * ERA, G), e1);
  assert.equal(emittedUntil(G + 2 * ERA + 1, G) - e1, RATE0 >> 2n);
  // ceiling one second before boundary refuses what one second after allows
  const at = e0 - RATE0; // mined exactly up to the boundary minus one era-0 second
  assert.equal(gate({ amount: RATE0 + 1n, ledgerMined: at, nowSec: G + ERA }).ok, false);
  assert.equal(gate({ amount: RATE0 + 1n, ledgerMined: at, nowSec: G + ERA + 1 }).ok, true);
});
test('minedFromLedger sums only network-day keys', () => {
  assert.equal(minedFromLedger({ 'D1|*': '7', 'D1|W': '7', 'D2|*': '5', 'D2|X': '5' }), 12n);
  assert.equal(minedFromLedger({}), 0n);
  assert.equal(minedFromLedger(undefined), 0n);
});
test('gate passes normal claim inside schedule', () => {
  const r = gate();
  assert.equal(r.ok, true); assert.equal(r.allowed, RATE0 * 3600n); assert.equal(r.minedTotal, 0n);
});
test('ceiling hit -> refuse (ledger total), exactly-at-ceiling allowed', () => {
  const allowed = emittedUntil(G + 3600, G);
  assert.equal(gate({ amount: 1n, ledgerMined: allowed }).error, 'exceeds emission schedule');
  assert.equal(gate({ amount: 1n, ledgerMined: allowed - 1n }).ok, true);
  assert.equal(gate({ amount: 2n, ledgerMined: allowed - 1n }).ok, false);
});
test('wiped ledger cannot reset ceiling: on-chain supply floors mined total', () => {
  const allowed = emittedUntil(G + 3600, G);
  const r = gate({ amount: 1n, ledgerMined: 0n, chainSupply: LAUNCH_BASE + allowed });
  assert.equal(r.ok, false); assert.equal(r.error, 'exceeds emission schedule'); assert.equal(r.chainMined, allowed);
  const b = gate({ amount: 1n, ledgerMined: allowed, chainSupply: LAUNCH_BASE }); // burns lowered supply: ledger still counts
  assert.equal(b.ok, false); assert.equal(b.minedTotal, allowed);
});
test('hard max supply even if schedule would allow', () => {
  const r = gate({ amount: 2n, chainSupply: MAX_SUPPLY_BASE - 1n, ledgerMined: 0n, nowSec: G + ERA * 50, launch: MAX_SUPPLY_BASE });
  assert.equal(r.error, 'exceeds max supply');
  assert.equal(gate({ amount: 1n, chainSupply: MAX_SUPPLY_BASE - 1n, nowSec: G + ERA * 50, launch: MAX_SUPPLY_BASE }).ok, true);
});
test('gate rejects garbage inputs (fail closed, no silent pass)', () => {
  assert.throws(() => gate({ amount: 0n }));
  assert.throws(() => gate({ amount: 5 }));
  assert.throws(() => gate({ chainSupply: undefined }));
  assert.throws(() => gate({ chainSupply: -1n }));
  assert.throws(() => gate({ ledgerMined: -1n }));
  assert.throws(() => gate({ nowSec: NaN }));
});
