import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceTier, capUnits } from '../mine-rules.mjs';
test('legacy msg = phone k1', () => assert.equal(deviceTier(undefined).k, 1));
test('unknown tier rejected', () => assert.throws(() => deviceTier('gpu', 8, 5)));
test('bad fields rejected', () => assert.throws(() => deviceTier('laptop', 'x', 5)));
test('real server kept', () => assert.deepEqual(deviceTier('server', 16, 8).tier, 'server'));
test('fake server → laptop / phone', () => {
  assert.equal(deviceTier('server', 8, 10).tier, 'laptop');
  assert.equal(deviceTier('server', 2, 90).tier, 'phone');
  assert.equal(deviceTier('laptop', 4, 60).downgraded, true);
});
test('clip and reject', () => {
  assert.deepEqual(capUnits(50, 60, 1), { units: 50, max: 60, clipped: false });
  assert.deepEqual(capUnits(100, 60, 1), { units: 60, max: 60, clipped: true });
  assert.throws(() => capUnits(121, 60, 1));
  assert.equal(capUnits(300, 60, 6).clipped, false);
  assert.throws(() => capUnits(1, 0.5, 1));
});
