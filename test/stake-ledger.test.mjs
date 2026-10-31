import assert from 'node:assert/strict';
import test from 'node:test';
import { planReturns, parseReturnMemo, returnMemo, parseStakeMemo, toBase } from '../stake/ledger.mjs';
const W = '6gXafzpPUShAf5Voy7NvQHDw6uGEQ7K9UhF96eG5mhFQ', D = 86400000, T0 = 1_700_000_000_000;
const st = (b, ts, sig) => ({ kind: 'stake', wallet: W, base: toBase(b), ts, sig });
const un = (b, ts, sig) => ({ kind: 'unstake', wallet: W, base: toBase(b), ts, sig });
const rt = (b, ts, sig, ref) => ({ kind: 'return', wallet: W, base: toBase(b), ts, sig, ref });
test('memo round trip + token.html compat', () => {
  const m = returnMemo(W, toBase('1.5'), 123, 'sigABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk');
  assert.equal(parseReturnMemo(m).amount, '1.5');
  assert.ok(/AEGIS\/return\/v1\|([1-9A-HJ-NP-Za-km-z]{32,44})/.test(m));
  assert.equal(parseStakeMemo(`AEGIS/unstake/v1|${W}|2|5`).kind, 'unstake');
});
test('locked until 7 days', () => {
  const e = [st('10', T0, 's1'), un('4', T0 + D, 'u1')];
  assert.equal(planReturns(e, T0 + 7 * D).pending[0].ready, false);
  const p = planReturns(e, T0 + 8 * D + 1).pending; assert.equal(p[0].ready, true); assert.equal(p[0].base, toBase('4'));
});
test('never over-return: request > stake capped', () => {
  const p = planReturns([st('3', T0, 's'), un('5', T0, 'u'), un('2', T0 + 1, 'u2')], T0 + 30 * D).pending;
  assert.equal(p.length, 1); assert.equal(p[0].base, toBase('3'));
});
test('idempotent by ref and by FIFO cumulative', () => {
  const base = [st('10', T0, 's'), un('4', T0, 'u1'), un('3', T0 + 1, 'u2')];
  assert.equal(planReturns([...base, rt('4', T0 + 8 * D, 'r1', 'u1')], T0 + 30 * D).pending.map(x => x.unstakeSig).join(), 'u2');
  assert.equal(planReturns([...base, rt('4', T0 + 8 * D, 'r1')], T0 + 30 * D).pending.map(x => x.unstakeSig).join(), 'u2');
  assert.equal(planReturns([...base, rt('4', 1, 'r1', 'u1'), rt('3', 2, 'r2', 'u2')], T0 + 30 * D).pending.length, 0);
});
test('unstake before stake does not count', () => {
  assert.equal(planReturns([un('5', T0, 'u'), st('5', T0 + 1, 's')], T0 + 30 * D).pending.length, 0);
});
