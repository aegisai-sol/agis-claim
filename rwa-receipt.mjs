// Sealer-paid anchor: server ONLY verifies a Memo tx the sealer signed & paid. Firm never pays Memo fees.
export function memoFromLogs(logs = []) {
  return logs.map(l => { const x = String(l).match(/Memo \(len \d+\): "(.+)"/); return x && x[1]; }).find(Boolean) || null;
}
export function checkAnchorMemo(memo, job, { firmPayer = null, feePayer = null } = {}) {
  if (!memo || !memo.startsWith('AEGIS/rwa/v1|')) return { ok: false, error: 'no AEGIS/rwa/v1 memo in tx' };
  const p = memo.split('|');
  if (p[1] !== job.id) return { ok: false, error: 'memo job id mismatch' };
  if (p[2] !== job.fingerprint) return { ok: false, error: 'memo fingerprint mismatch' };
  if (firmPayer && feePayer && firmPayer === feePayer) return { ok: false, error: 'firm wallet may not pay public anchors' };
  return { ok: true, status: p[3] || null, sealedAt: p[4] || null, validUntil: p[5] && p[5] !== 'forever' ? p[5] : null };
}
export function buildAnchorMemo(job) {
  return `AEGIS/rwa/v1|${job.id}|${job.fingerprint}|${job.status}|${job.created}|${job.validUntil || 'forever'}`;
}
