import test from 'node:test'; import assert from 'node:assert';
import { memoFromLogs, checkAnchorMemo, buildAnchorMemo } from '../rwa-receipt.mjs';
const job = { id: 'abcdef123456', fingerprint: 'f'.repeat(64), status: 'open', created: '2026-10-31T18:00:00Z' };
const memo = buildAnchorMemo(job);
const logs = ['Program Memo invoke [1]', `Program log: Memo (len ${memo.length}): "${memo}"`];
test('sealer-paid memo verifies without any firm payer', () => { assert.equal(checkAnchorMemo(memoFromLogs(logs), job, { feePayer: 'Sealer111' }).ok, true); });
test('firm payer rejected', () => { assert.equal(checkAnchorMemo(memo, job, { firmPayer: 'F', feePayer: 'F' }).ok, false); });
test('wrong fingerprint rejected', () => { assert.equal(checkAnchorMemo(memo, { ...job, fingerprint: 'a'.repeat(64) }).ok, false); });
test('no memo rejected', () => { assert.equal(checkAnchorMemo(memoFromLogs(['x']), job).ok, false); });
