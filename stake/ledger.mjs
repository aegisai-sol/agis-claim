// Pure ledger math for AGIS Stake vault v1 (custodial). Mirrors aegisai docs/js/token-ops.js formats.
export const LOCK_DAYS = Number(process.env.LOCK_DAYS ?? 7);
export const DAY_MS = 86400000;
const B58 = '[1-9A-HJ-NP-Za-km-z]{32,88}';
const RE = /AEGIS\/(stake|unstake)\/v1\|([1-9A-HJ-NP-Za-km-z]{32,44})\|([\d.]+)\|(\d+)/;
const RET = new RegExp(`AEGIS\\/return\\/v1\\|([1-9A-HJ-NP-Za-km-z]{32,44})\\|([\\d.]+)\\|(\\d+)(?:\\|(${B58}))?`);
export function parseStakeMemo(s) { const m = RE.exec(s || ''); return m && { kind: m[1], wallet: m[2], amount: m[3], ts: +m[4] }; }
export function parseReturnMemo(s) { const m = RET.exec(s || ''); return m && { wallet: m[1], amount: m[2], ts: +m[3], ref: m[4] || null }; }
export function toBase(s) { s = String(s).trim(); if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error('bad amount ' + s); const [i, f = ''] = s.split('.'); return BigInt(i) * 10n ** 9n + BigInt((f + '000000000').slice(0, 9)); }
export const fromBase = v => { v = BigInt(v); const f = (v % 10n ** 9n).toString().padStart(9, '0').replace(/0+$/, ''); return (v / 10n ** 9n).toString() + (f ? '.' + f : ''); };
// Memo: ledger regex in token.html matches the first 4 fields; 5th field = unstake tx sig (idempotency ref).
export const returnMemo = (w, base, ts, ref) => `AEGIS/return/v1|${w}|${fromBase(base)}|${ts}${ref ? '|' + ref : ''}`;

/**
 * entries: [{kind:'stake'|'unstake'|'return', wallet, base:BigInt, ts(ms, chain blockTime), sig, ref?}]
 * Returns pending payouts: FIFO over unstake requests, capped by staked - returned, only after lock.
 */
export function planReturns(entries, now = Date.now(), lockDays = LOCK_DAYS) {
  const by = {};
  for (const e of [...entries].sort((a, b) => a.ts - b.ts)) (by[e.wallet] ||= []).push(e);
  const pending = [], summary = {};
  for (const [wallet, es] of Object.entries(by)) {
    let staked = 0n, returned = 0n;
    const doneRefs = new Set();
    for (const e of es) { if (e.kind === 'stake') staked += e.base; if (e.kind === 'return') { returned += e.base; if (e.ref) doneRefs.add(e.ref); } }
    // Requests are only valid against stake that existed at request time (no pre-requesting future stakes).
    let budget = 0n, covered = returned; // FIFO: already-returned amount covers oldest requests first
    let reqTotal = 0n; const reqs = [];
    for (const e of es) {
      if (e.kind === 'stake') budget += e.base;
      if (e.kind === 'unstake') { const amt = e.base <= budget - reqTotal ? e.base : (budget > reqTotal ? budget - reqTotal : 0n); if (amt > 0n) { reqs.push({ ...e, amt }); reqTotal += amt; } }
    }
    let avail = staked - returned; if (avail < 0n) avail = 0n;
    for (const r of reqs) {
      if (doneRefs.has(r.sig)) { covered -= r.amt; continue; }
      if (covered >= r.amt) { covered -= r.amt; continue; }
      let owe = r.amt - (covered > 0n ? covered : 0n); covered = 0n;
      if (owe > avail) owe = avail;
      if (owe <= 0n) continue;
      const due = r.ts + lockDays * DAY_MS;
      if (due > now) { pending.push({ wallet, base: owe, unstakeSig: r.sig, dueAt: due, ready: false }); avail -= owe; continue; }
      pending.push({ wallet, base: owe, unstakeSig: r.sig, dueAt: due, ready: true }); avail -= owe;
    }
    summary[wallet] = { staked: fromBase(staked), requested: fromBase(reqTotal), returned: fromBase(returned) };
  }
  return { pending, summary };
}
