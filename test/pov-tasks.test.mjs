import test from 'node:test';
import assert from 'node:assert/strict';
import { issueBatch, parseBatch, deriveTasks, solveTask, encodeAnswers, gradeAnswers, MAX_TASKS } from '../pov-tasks.mjs';
const S = Buffer.from('test-secret'), W = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', T0 = 1_800_000_000, N = '0123456789abcdef';

test('honest solver scores 100% and passes', () => {
  const { batchId, tasks } = issueBatch(S, W, 60, T0, N);
  const r = gradeAnswers(S, batchId, encodeAnswers(tasks.map(solveTask)));
  assert.equal(r.correct, 60); assert.equal(r.pass, true);
});
test('solver agrees with server truth on many batches (all task kinds)', () => {
  const kinds = new Set();
  for (let k = 0; k < 20; k++) {
    const { batchId } = issueBatch(S, W, 120, T0 + k, N);
    for (const t of deriveTasks(S, batchId)) { assert.equal(solveTask(t.text), t.truth, t.text); kinds.add(t.text[0]); }
  }
  assert.equal(kinds.size >= 3, true);
});
test('random guessing fails the accuracy gate', () => {
  let passes = 0;
  for (let k = 0; k < 50; k++) {
    const { batchId } = issueBatch(S, W, 60, T0 + k, N);
    const guess = Array.from({ length: 60 }, (_, i) => ((k * 7 + i * 13) % 5) < 2);
    if (gradeAnswers(S, batchId, encodeAnswers(guess)).pass) passes++;
    if (gradeAnswers(S, batchId, encodeAnswers(Array(60).fill(true))).pass) passes++;
  }
  assert.equal(passes, 0);
});
test('batch is bound to wallet, secret and time', () => {
  const { batchId } = issueBatch(S, W, 10, T0, N);
  assert.equal(parseBatch(S, W, batchId, T0 + 60).n, 10);
  assert.throws(() => parseBatch(S, 'OtherWallet1111111111111111111111111111111', batchId, T0), /not issued/);
  assert.throws(() => parseBatch(Buffer.from('x'), W, batchId, T0), /not issued/);
  assert.throws(() => parseBatch(S, W, batchId, T0 + 25 * 3600), /expired/);
  assert.throws(() => parseBatch(S, W, batchId.replace('.10.', '.11.'), T0), /not issued/);
  assert.throws(() => parseBatch(S, W, 'junk', T0), /bad batch/);
});
test('bad inputs fail closed', () => {
  assert.throws(() => issueBatch(S, W, MAX_TASKS + 1, T0, N));
  assert.throws(() => issueBatch(S, W, 0, T0, N));
  const { batchId } = issueBatch(S, W, 10, T0, N);
  assert.throws(() => gradeAnswers(S, batchId, 'zz00'), /bad answers/);
  assert.throws(() => gradeAnswers(S, batchId, 'ff'), /bad answers/);
  assert.throws(() => solveTask('rm -rf'), /unknown task/);
});
