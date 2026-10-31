// AGIS Stake vault v1 return worker (custodial). Usage: node stake/return-worker.mjs [--send]
// Default = dry run. Env: STAKE_VAULT_JSON (secret key JSON array; only needed for --send), SOLANA_RPC, LOCK_DAYS, MIN_SOL.
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { parseStakeMemo, parseReturnMemo, toBase, fromBase, planReturns, returnMemo, LOCK_DAYS } from './ledger.mjs';

export const VAULT = new PublicKey('6gXafzpPUShAf5Voy7NvQHDw6uGEQ7K9UhF96eG5mhFQ');
export const VAULT_ATA = new PublicKey('DhFNmnZs9TzhqLrxLWHd2uXZy3stg8dV7tMSicSX3cWJ');
export const MINT = new PublicKey('GhSiU95vtKwn7FBAW1u5krxYP2PnpFPotb1LJFZkbzhW');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RPC = process.env.SOLANA_RPC || process.env.HELIUS_RPC || 'https://solana-rpc.publicnode.com';
const MIN_SOL = Number(process.env.MIN_SOL ?? 0.005);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function allSigs(c, addr) { const out = []; let before; for (;;) { const b = await c.getSignaturesForAddress(addr, { limit: 1000, before }); out.push(...b); if (b.length < 1000) return out; before = b.at(-1).signature; } }

export async function readEntries(c) {
  const seen = new Map();
  for (const a of [VAULT_ATA, VAULT]) for (const s of await allSigs(c, a)) if (!s.err) seen.set(s.signature, s);
  const out = [];
  for (const sig of seen.keys()) {
    let tx; for (let i = 0; i < 4 && !tx; i++) { tx = await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null); if (!tx) await sleep(400 * (i + 1)); }
    if (!tx || tx.meta?.err) continue;
    const ins = tx.transaction.message.instructions, ts = (tx.blockTime || 0) * 1000;
    const memos = ins.filter(i => typeof i.parsed === 'string').map(i => i.parsed);
    const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey?.toString();
    for (const i of ins) {
      const p = i.parsed; if (!p || p.type !== 'transferChecked' || p.info.mint !== MINT.toBase58()) continue;
      const amt = BigInt(p.info.tokenAmount.amount);
      if (p.info.destination === VAULT_ATA.toBase58()) { const m = memos.map(parseStakeMemo).find(x => x && x.kind === 'stake'); if (m && m.wallet === signer) out.push({ kind: 'stake', wallet: signer, base: amt, ts, sig }); }
      else if (p.info.source === VAULT_ATA.toBase58()) { const r = memos.map(parseReturnMemo).find(Boolean); if (r) out.push({ kind: 'return', wallet: r.wallet, base: amt, ts, sig, ref: r.ref }); }
    }
    for (const m of memos.map(parseStakeMemo)) if (m && m.kind === 'unstake' && m.wallet === signer) { try { out.push({ kind: 'unstake', wallet: signer, base: toBase(m.amount), ts, sig }); } catch {} }
  }
  return out;
}

export async function run({ send = false, log = console.log } = {}) {
  const c = new Connection(RPC, 'confirmed');
  const entries = await readEntries(c);
  const { pending, summary } = planReturns(entries, Date.now(), LOCK_DAYS);
  const lamports = await c.getBalance(VAULT); const sol = lamports / 1e9;
  let vaultAgis = 0n; try { vaultAgis = BigInt((await c.getTokenAccountBalance(VAULT_ATA)).value.amount); } catch {}
  const report = { mode: send ? 'send' : 'dry-run', lockDays: LOCK_DAYS, vaultSol: sol, vaultAgis: fromBase(vaultAgis), entries: entries.length, summary,
    pending: pending.map(p => ({ wallet: p.wallet, amount: fromBase(p.base), unstakeSig: p.unstakeSig, dueAt: new Date(p.dueAt).toISOString(), ready: p.ready })), sent: [], stopped: null };
  const ready = pending.filter(p => p.ready);
  if (!send || !ready.length) return report;
  if (sol < MIN_SOL) { report.stopped = `vault SOL ${sol} < MIN_SOL ${MIN_SOL}; fund ${VAULT.toBase58()}`; return report; }
  const raw = process.env.STAKE_VAULT_JSON; if (!raw) { report.stopped = 'STAKE_VAULT_JSON not set'; return report; }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (!kp.publicKey.equals(VAULT)) { report.stopped = 'STAKE_VAULT_JSON pubkey mismatch'; return report; }
  let left = vaultAgis;
  for (const p of ready) {
    if (p.base > left) { report.stopped = `vault AGIS short for ${p.unstakeSig}`; break; }
    const owner = new PublicKey(p.wallet), dst = getAssociatedTokenAddressSync(MINT, owner, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(VAULT, dst, owner, MINT),
      createTransferCheckedInstruction(VAULT_ATA, MINT, dst, VAULT, p.base, 9),
      new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: VAULT, isSigner: true, isWritable: false }], data: Buffer.from(returnMemo(p.wallet, p.base, Date.now(), p.unstakeSig)) }));
    try { const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed'); tx.recentBlockhash = blockhash; tx.feePayer = VAULT; tx.sign(kp);
      const sig = await c.sendRawTransaction(tx.serialize()); const r = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (r.value?.err) throw new Error(JSON.stringify(r.value.err)); left -= p.base; report.sent.push({ wallet: p.wallet, amount: fromBase(p.base), sig });
      log('returned', p.wallet, fromBase(p.base), sig);
    } catch (e) { report.stopped = 'send failed: ' + e.message; break; } // stop; next run re-reads chain (idempotent)
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({ send: process.argv.includes('--send') }).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.stopped ? 2 : 0); }).catch(e => { console.error(e); process.exit(1); });
}
