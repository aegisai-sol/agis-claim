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
