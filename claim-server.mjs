// AGIS always-on claim server: verifies wallet-signed mining claims and mints AGIS instantly.
// Run: MAINNET=1 SOLANA_KEYPAIR=<mint-authority.json> PORT=8787 node scripts/claim-server.mjs
// Keys are read from disk only; never printed or returned.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { Connection, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { connection, loadKeypair, DECIMALS } from './common.mjs';

const MINT = new PublicKey('GhSiU95vtKwn7FBAW1u5krxYP2PnpFPotb1LJFZkbzhW');
const GENESIS = Number(process.env.AGIS_GENESIS || Date.parse('2026-10-31T00:00:00Z') / 1000);
const ERA = 2 * 365 * 24 * 3600;
const RATE0 = (8_500_000_000n * 10n ** 9n / 2n) / BigInt(ERA);
const UNIT_BPS = BigInt(process.env.UNIT_BPS || 1);
const DAILY_CAP = BigInt(process.env.DAILY_CAP_AGIS || 100) * 10n ** BigInt(DECIMALS);
const GLOBAL_DAILY_CAP = BigInt(process.env.GLOBAL_DAILY_CAP_AGIS || 100000) * 10n ** BigInt(DECIMALS);
const MIN_SOL_LAMPORTS = 3_000_000;
const MAX_CLAIM_AGE_MS = 24 * 3600e3;
const LEDGER = process.env.LEDGER || './deployments/claims-ledger.json';
const PORT = Number(process.env.PORT || 8787);
const ALLOW = /^https:\/\/([a-z0-9-]+\.github\.io|[a-z0-9-]+\.here\.now|(www\.)?aegisai\.xyz)$/i;

const verify = (wallet, msg, sigB64) => {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(wallet))]);
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(msg, 'utf8'), key, Buffer.from(sigB64, 'base64'));
};
fs.mkdirSync('./deployments', { recursive: true });
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { seen: {}, day: {} };
const save = () => fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
const conn = connection();
const confirmConn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
async function waitSigLanded(sig) {
  for (let i = 0; i < 30; i++) {
    for (const c of [confirmConn, conn]) {
      try {
        const st = (await c.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (st?.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.err));
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return true;
      } catch (e) { if (String(e.message||e).startsWith('tx failed')) throw e; }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}
function sigFromErr(e) {
  const m = String(e && e.message || e).match(/\b([1-9A-HJ-NP-Za-km-z]{80,90})\b/);
  return m ? m[1] : null;
}

let payer = null;
const getPayer = () => {
  if (!payer) payer = loadKeypair();
  return payer;
};
const hits = new Map(); // ip/wallet -> [timestamps]
const limited = (k, n, ms) => { const now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > n; };
let queue = Promise.resolve(); // serialize mints

// ---- RWA jobs API v1 (document verification; miners see ciphertext + hash only) ----
// On verdict: Solana Memo receipt (AEGIS/rwa/v1|id|fp|status) from payer key; never blocks the vote.
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RWA_MEMO = process.env.RWA_MEMO !== '0';
const RWA_DIR = process.env.RWA_DIR || './deployments/rwa-jobs';
const RWA_INDEX = RWA_DIR + '/index.json';
const RWA_MAX_BODY = 4 * 1024 * 1024;
const RWA_VOTES_NEEDED = Number(process.env.RWA_VOTES || 1);
fs.mkdirSync(RWA_DIR, { recursive: true });
const rwa = fs.existsSync(RWA_INDEX) ? JSON.parse(fs.readFileSync(RWA_INDEX, 'utf8')) : { jobs: {} };
const rwaSave = () => fs.writeFileSync(RWA_INDEX, JSON.stringify(rwa, null, 1));
const pub = j => ({ receiptTx: j.receiptTx ?? null, receiptError: j.receiptError ?? null, receiptAt: j.receiptAt ?? null, id: j.id, fingerprint: j.fingerprint, meta: j.meta, status: j.status, created: j.created, rewardEstimate: j.rewardEstimate ?? null, hasCiphertext: !!j.ctFile, keyWrap: j.keyWrap ?? null, wrapWallet: j.wrapWallet ?? null, wrapAlg: j.wrapAlg ?? null, votes: (j.votes || []).map(v => ({ wallet: v.wallet, ok: v.ok, checks: v.checks, at: v.at })) });
function rwaCreate(b) {
  if (!b || typeof b.fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(b.fingerprint)) throw 'fingerprint must be sha256 hex';
  // Privacy: we never accept or store decryption keys. Reject any key-like field.
  const bad = k => /key|secret|password|plain/i.test(k);
  if (Object.keys(b).some(bad) || Object.keys(b.meta || {}).some(bad)) throw 'key fields are never accepted';
  const m = b.meta || {};
  const meta = { type: String(m.type || 'doc').slice(0, 24), pages: Math.max(1, Math.min(10000, Number(m.pages) || 1)) };
  if (m.name) meta.name = String(m.name).slice(0, 120);
  if (m.iv) meta.iv = String(m.iv).slice(0, 64);
  if (m.enc) meta.enc = String(m.enc).slice(0, 24);
  if (m.bytes) meta.bytes = Number(m.bytes) || 0;
  const id = crypto.randomBytes(6).toString('hex'), created = new Date().toISOString();
  const j = { id, fingerprint: b.fingerprint.toLowerCase(), meta, status: 'open', created, rewardEstimate: Number(b.rewardEstimate) || null, votes: [] };
  if (typeof b.ciphertextB64 === 'string' && b.ciphertextB64.length) {
    if (!/^[A-Za-z0-9+/=]+$/.test(b.ciphertextB64)) throw 'ciphertext must be base64';
    fs.writeFileSync(`${RWA_DIR}/${id}.b64`, b.ciphertextB64); j.ctFile = id + '.b64';
  }
  rwa.jobs[id] = j; rwaSave();
  return { ok: true, id, created };
}
// Wave A2 wallet key-wrap. Client wraps its AES key with HKDF(Phantom sig of AEGIS/rwa-keywrap/v1|wallet|id|fp).
// That derivation signature NEVER reaches us; we only get the opaque wrapped blob, authorised by a separate
// attach signature (AEGIS/rwa-keywrap-attach/v1|wallet|id|fp|ts). Write-once. We never custody keys.
// TODO social recovery (2-of-3 guardians, Shamir shares of the AES key) — design stub only.
function rwaKeyWrap(id, v) {
  const j = rwa.jobs[id]; if (!j) throw 'no such job';
  if (j.keyWrap) throw 'keyWrap already set';
  if (!v || typeof v.wallet !== 'string' || typeof v.msg !== 'string' || typeof v.sig !== 'string' || typeof v.keyWrap !== 'string') throw 'bad body';
  if (!/^[A-Za-z0-9+/=]{40,400}$/.test(v.keyWrap) || v.msg.length > 300) throw 'bad keyWrap';
  const [dom, w, jid, fp] = v.msg.split('|');
  if (dom !== 'AEGIS/rwa-keywrap-attach/v1' || w !== v.wallet || jid !== id || fp !== j.fingerprint) throw 'bad message';
  new PublicKey(w); if (!verify(v.wallet, v.msg, v.sig)) throw 'bad signature';
  Object.assign(j, { keyWrap: v.keyWrap, wrapWallet: w, wrapAlg: 'hkdf-sha256(ed25519-sig)+aes-gcm-256/v1' }); rwaSave();
  return { ok: true, id, wrapWallet: w };
}
function rwaVote(id, v) {
  const j = rwa.jobs[id]; if (!j) throw 'no such job';
  if (!v || typeof v.wallet !== 'string' || typeof v.msg !== 'string' || typeof v.sig !== 'string' || !v.result) throw 'bad body';
  if (v.msg.length > 300) throw 'bad message';
  const [dom, w, jid, fp] = v.msg.split('|'); // AEGIS/rwa-vote/v1|wallet|jobId|fingerprint|ts
  if (dom !== 'AEGIS/rwa-vote/v1' || w !== v.wallet || jid !== id || fp !== j.fingerprint) throw 'bad message';
  new PublicKey(w);
  if (!verify(v.wallet, v.msg, v.sig)) throw 'bad signature';
  if (j.votes.some(x => x.wallet === w)) throw 'already voted';
  const ok = !!v.result.ok, checks = Array.isArray(v.result.checks) ? v.result.checks.slice(0, 20).map(c => String(c).slice(0, 80)) : [];
  j.votes.push({ wallet: w, ok, checks, sig: v.sig, at: new Date().toISOString() });
  if (j.votes.length >= RWA_VOTES_NEEDED) { const yes = j.votes.filter(x => x.ok).length; j.status = yes * 2 > j.votes.length ? 'verified' : 'failed'; rwaReceipt(j); }
  rwaSave(); return { ok: true, id, status: j.status, votes: j.votes.length };
}

function rwaReceipt(j) {
  if (j.receiptTx || j.receiptPending) return;
  if (!RWA_MEMO) { j.receiptTx = null; j.receiptError = 'memo disabled'; return; }
  j.receiptPending = true;
  queue = queue.then(async () => {
    try {
      const kp = getPayer();
      const bal = await conn.getBalance(kp.publicKey, 'confirmed');
      if (bal < MIN_SOL_LAMPORTS) throw new Error('low SOL on payer (' + bal + ' lamports · ' + kp.publicKey.toBase58().slice(0, 8) + '…)');
      // Timestamped seal receipt on Solana L1 (immutable hash+time+verdict). Not an eIDAS qualified notary.
      const sealedAt = j.created || new Date().toISOString();
      const memo = `AEGIS/rwa/v1|${j.id}|${j.fingerprint}|${j.status}|${sealedAt}`;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized');
          const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash, lastValidBlockHeight }).add(
            new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') })
          );
          tx.sign(kp);
          const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
          const ok = await waitSigLanded(sig);
          if (!ok) throw new Error('Signature ' + sig + ' has expired: block height exceeded');
          j.receiptTx = sig; j.receiptError = null; lastErr = null; break;
        } catch (e) {
          lastErr = e;
          const maybe = sigFromErr(e);
          if (maybe && await waitSigLanded(maybe).catch(() => false)) {
            j.receiptTx = maybe; j.receiptError = null; lastErr = null; break;
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
    } catch (e) {
      let msg = String(e.message || e);
      // Last chance: salvage sig from error if it finalized on alternate RPC
      const maybe = sigFromErr(e);
      if (maybe) {
        try {
          if (await waitSigLanded(maybe)) { j.receiptTx = maybe; j.receiptError = null; msg = null; }
        } catch {}
      }
      if (msg) { j.receiptTx = null; j.receiptError = msg.slice(0, 240); }
    }
    j.receiptAt = new Date().toISOString(); delete j.receiptPending; rwaSave();
  }).catch(() => {});
}
async function rwaReceiptRetry(id) {
  const j = rwa.jobs[id]; if (!j) throw 'no such job';
  if (j.status !== 'verified' && j.status !== 'failed') throw 'not settled';
  if (j.receiptTx) return { ok: true, id, receiptTx: j.receiptTx, reused: true };
  const maybe = sigFromErr(j.receiptError || '');
  if (maybe && await waitSigLanded(maybe).catch(() => false)) {
    j.receiptTx = maybe; j.receiptError = null; j.receiptAt = new Date().toISOString(); rwaSave();
    return { ok: true, id, receiptTx: maybe, salvaged: true };
  }
  delete j.receiptPending; j.receiptError = null; rwaReceipt(j);
  return { ok: true, id, retried: true };
}

async function handle(c) {
  if (!c || typeof c.wallet !== 'string' || typeof c.msg !== 'string' || typeof c.sig !== 'string') throw 'bad body';
  if (c.msg.length > 300) throw 'bad message';
  const [dom, w, tasks, from, to, dg] = c.msg.split('|');
  if (dom !== 'AEGIS/mine-claim/v1' || w !== c.wallet || !dg) throw 'bad message';
  new PublicKey(w);
  if (!verify(c.wallet, c.msg, c.sig)) throw 'bad signature';
  if (ledger.seen[dg] || ledger.seen['sig:' + c.sig]) throw 'replay';
  const tf = Date.parse(from), tt = Date.parse(to), now = Date.now();
  if (!(tt <= now + 120e3 && now - tt < MAX_CLAIM_AGE_MS)) throw 'claim expired';
  const secs = (tt - tf) / 1000, n = Number(tasks);
  if (!(secs > 0 && Number.isInteger(n) && n > 0 && n <= secs)) throw 'implausible work (max 1 task/sec)';
  const era = Math.floor((tf / 1000 - GENESIS) / ERA);
  let amt = (RATE0 >> BigInt(Math.max(era, 0))) * BigInt(n) * UNIT_BPS / 10000n;
  const day = new Date().toISOString().slice(0, 10), k = day + '|' + w, used = BigInt(ledger.day[k] || 0);
  const gk = day + '|*', gused = BigInt(ledger.day[gk] || 0);
  if (used + amt > DAILY_CAP) amt = DAILY_CAP - used;
  if (gused + amt > GLOBAL_DAILY_CAP) amt = GLOBAL_DAILY_CAP - gused;
  if (amt <= 0n) throw 'daily cap reached';
  if ((await conn.getBalance(getPayer().publicKey)) < MIN_SOL_LAMPORTS) throw 'payout wallet low on SOL, try later';
  ledger.seen[dg] = 'pending'; save();
  try {
    const ata = await getOrCreateAssociatedTokenAccount(conn, getPayer(), MINT, new PublicKey(w));
    const tx = await mintTo(conn, getPayer(), MINT, ata.address, getPayer(), amt);
    ledger.seen[dg] = tx; ledger.seen['sig:' + c.sig] = tx;
    ledger.day[k] = String(used + amt); ledger.day[gk] = String(gused + amt); save();
    console.log(new Date().toISOString(), 'minted', w, Number(amt) / 10 ** DECIMALS, tx);
    return { ok: true, amount: Number(amt) / 10 ** DECIMALS, tx, explorer: 'https://solscan.io/tx/' + tx };
  } catch (e) { delete ledger.seen[dg]; save(); throw 'mint failed: ' + (e.message || e); }
}

http.createServer((req, res) => {
  const o = req.headers.origin || '';
  const h = { 'content-type': 'application/json', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type, bypass-tunnel-reminder' };
  if (ALLOW.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o)) h['access-control-allow-origin'] = o;
  const out = (s, j) => { res.writeHead(s, h); res.end(JSON.stringify(j)); };
  if (req.method === 'OPTIONS') return out(204, {});
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/api/health')) {
      let payerPk = null; try { payerPk = getPayer().publicKey.toBase58(); } catch {}
      return out(200, { ok: true, mint: MINT.toBase58(), live: true, rwa: true, jobs: Object.keys(rwa.jobs).length, mainnet: process.env.MAINNET === '1', payer: payerPk ? payerPk.slice(0, 8) + '…' + payerPk.slice(-4) : null, rpc: (process.env.SOLANA_RPC || (process.env.MAINNET === '1' ? 'mainnet-default' : 'devnet')).replace(/api[_-]?key=[^&]+/ig, 'api_key=…') });
    }
  if (req.method === 'GET' && url === '/api/supply') {
    return Promise.all([conn.getTokenSupply(MINT), conn.getSlot().catch(() => null)])
      .then(([s, slot]) => out(200, { ok: true, mint: MINT.toBase58(), supply: s.value.amount, uiAmount: s.value.uiAmount, uiAmountString: s.value.uiAmountString, decimals: s.value.decimals, slot }))
      .catch(e => out(502, { ok: false, error: String(e) }));
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (url.startsWith('/api/rwa')) {
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    if (limited('rwa:' + ip, req.method === 'GET' ? 120 : 20, 60e3)) return out(429, { ok: false, error: 'rate limited' });
    if (req.method === 'GET' && url === '/api/rwa/health') return out(200, { ok: true, rwa: true, jobs: Object.keys(rwa.jobs).length, open: Object.values(rwa.jobs).filter(j => j.status === 'open').length });
    if (req.method === 'GET' && url === '/api/rwa/jobs') {
      const st = qs.get('status') || 'open';
      return out(200, { ok: true, jobs: Object.values(rwa.jobs).filter(j => st === 'all' || j.status === st).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 200).map(pub) });
    }
    // Recovery: lost phone/key -> re-hash same file -> public proof by fingerprint. Public fields only, never ciphertext.
    const fm = url.match(/^\/api\/rwa\/by-fingerprint\/([0-9a-fA-F]{64})$/) || (url === '/api/rwa/by-fingerprint' && [0, qs.get('fp') || '']);
    if (req.method === 'GET' && fm) {
      const fp = String(fm[1]).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(fp)) return out(400, { ok: false, error: 'fp must be sha256 hex' });
      const seals = Object.values(rwa.jobs).filter(j => j.fingerprint === fp).sort((a, b) => a.created.localeCompare(b.created)).map(pub).map(({ votes, ...r }) => ({ ...r, keyWrap: undefined, walletRecovery: !!r.keyWrap, votes: votes.length, meta: { type: r.meta.type, pages: r.meta.pages, bytes: r.meta.bytes } }));
      return out(200, { ok: true, fingerprint: fp, found: seals.length > 0, seals });
    }
    const m = url.match(/^\/api\/rwa\/jobs\/([0-9a-f]{12})(\/vote|\/keywrap|\/receipt-retry)?$/);
    if (req.method === 'GET' && m && !m[2]) {
      const j = rwa.jobs[m[1]]; if (!j) return out(404, { ok: false, error: 'no such job' });
      const r = pub(j);
      if (qs.get('full') === '1' && j.ctFile) r.ciphertextB64 = fs.readFileSync(`${RWA_DIR}/${j.ctFile}`, 'utf8');
      return out(200, { ok: true, job: r });
    }
    if (m && m[2] === '/receipt-retry' && (req.method === 'POST' || req.method === 'GET')) {
      try { return out(200, rwaReceiptRetry(m[1])); } catch (e) { return out(400, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method !== 'POST' || !(url === '/api/rwa/jobs' || (m && m[2]))) return out(404, { ok: false, error: 'not found' });
    let b = '', big = false;
    req.on('data', d => { if (big) return; b += d; if (b.length > RWA_MAX_BODY) { big = true; out(413, { ok: false, error: 'body too large (max 4MB)' }); req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      let c; try { c = JSON.parse(b); } catch { return out(400, { ok: false, error: 'bad json' }); }
      try {
        if (!m) out(200, rwaCreate(c));
        else if (m[2] === '/keywrap') out(200, rwaKeyWrap(m[1], c));
        else if (m[2] === '/receipt-retry') return out(200, await rwaReceiptRetry(m[1]));
        else out(200, rwaVote(m[1], c));
      } catch (e) { out(400, { ok: false, error: String(e.message || e) }); }
    });
    return;
  }
  if (req.method !== 'POST' || url !== '/api/claim') return out(404, { ok: false, error: 'not found' });
  let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
  req.on('end', () => {
    let c; try { c = JSON.parse(b); } catch { return out(400, { ok: false, error: 'bad json' }); }
    if (c && typeof c.wallet === 'string' && limited('w:' + c.wallet, 5, 60e3)) return out(429, { ok: false, error: 'rate limited' });
    queue = queue.then(() => handle(c)).then(r => out(200, r), e => out(400, { ok: false, error: String(e) }));
  });
}).listen(PORT, '0.0.0.0', () => { let p = 'unset'; try { p = getPayer().publicKey.toBase58(); } catch {} console.log('claim server on', PORT, 'payer', p); });

