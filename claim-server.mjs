// AGIS always-on claim server: verifies wallet-signed mining claims and mints AGIS instantly.
// Run: MAINNET=1 SOLANA_KEYPAIR=<mint-authority.json> PORT=8787 node scripts/claim-server.mjs
// Keys are read from disk only; never printed or returned.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
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
let payer = null;
const getPayer = () => {
  if (!payer) payer = loadKeypair();
  return payer;
};
const hits = new Map(); // ip/wallet -> [timestamps]
const limited = (k, n, ms) => { const now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > n; };
let queue = Promise.resolve(); // serialize mints

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
  if (req.method === 'GET' && (url === '/' || url === '/api/health')) return out(200, { ok: true, mint: MINT.toBase58(), live: true });
  if (req.method === 'GET' && url === '/api/supply') {
    return Promise.all([conn.getTokenSupply(MINT), conn.getSlot().catch(() => null)])
      .then(([s, slot]) => out(200, { ok: true, mint: MINT.toBase58(), supply: s.value.amount, uiAmount: s.value.uiAmount, uiAmountString: s.value.uiAmountString, decimals: s.value.decimals, slot }))
      .catch(e => out(502, { ok: false, error: String(e) }));
  }
  if (req.method !== 'POST' || url !== '/api/claim') return out(404, { ok: false, error: 'not found' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (limited('ip:' + ip, 10, 60e3)) return out(429, { ok: false, error: 'rate limited' });
  let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
  req.on('end', () => {
    let c; try { c = JSON.parse(b); } catch { return out(400, { ok: false, error: 'bad json' }); }
    if (c && typeof c.wallet === 'string' && limited('w:' + c.wallet, 5, 60e3)) return out(429, { ok: false, error: 'rate limited' });
    queue = queue.then(() => handle(c)).then(r => out(200, r), e => out(400, { ok: false, error: String(e) }));
  });
}).listen(PORT, '0.0.0.0', () => console.log('claim server on', PORT, 'payer', getPayer().publicKey.toBase58()));

