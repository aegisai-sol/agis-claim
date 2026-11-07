# AGIS Claim API

Public mint-claim HTTPS service for [AegisAI](https://aegisai-sol.github.io/aegisai/).

- `GET /api/health`
- `POST /api/claim` — wallet-signed mining claims (gated by the mine-pool schedule ceiling below)
- `GET /api/mine/schedule` — public emission audit (era, rate, emittedUntil, ledger/chain mined, headroom, withinSchedule)

### Mine-pool schedule ceiling (fail closed)
Checked before every mine/house reward mint, on top of the env daily caps:
- cumulative mined + amount ≤ `emittedUntil(now)` (halving every ~2y from `AGIS_GENESIS`, era-0 rate = pool/2/era; never exceeds the 85% mine pool)
- on-chain supply + amount ≤ max supply
- mined total = max(ledger sum of `YYYY-MM-DD|*`, on-chain supply − 15% launch) → a wiped ledger cannot reset the ceiling
- supply unreadable on `SOLANA_RPC` and fallback `SOLANA_CONFIRM_RPC` (default api.mainnet-beta) → claim refused `supply check unavailable`
- `AGIS_MAX_SUPPLY` (whole AGIS, default `10000000000` = live mint) is the single knob; pool 85% / launch 15% / rate derive from it.
  Note: older owner plan text says 1B; chain mint + code use 10B. Setting 1B while chain supply is 1.5B would refuse every mint (fail closed).
- Tests: `npm test` (unit + shared JS/Python vectors + fake-RPC E2E, no keys/network)

**Secrets (host env only, never commit):**
- `MINT_AUTH_JSON` — mint authority keypair JSON array
- `MAINNET=1`
- optional `SOLANA_RPC`

Mint: `GhSiU95vtKwn7FBAW1u5krxYP2PnpFPotb1LJFZkbzhW`

### Recovery (lost phone / lost key)
`GET /api/rwa/by-fingerprint/:sha256` (or `?fp=`) — public fields only (id, status, receiptTx, created, minimal meta). Re-hash the same file to prove it matches an existing seal; no key needed. Key only needed to decrypt the stored ciphertext.
`POST /api/rwa/jobs/:id/keywrap` {wallet,msg,sig,keyWrap} — Wave A2 wallet-bound key wrap blob, write-once; msg `AEGIS/rwa-keywrap-attach/v1|wallet|id|fp|ts`. Server never sees the key or the derivation signature.

## Seal attestation (pov-r/seal-attest/1)

Once a seal has an on-chain `receiptTx`, every job response includes `attestation`: an Ed25519 signature by the AGIS claim server over pinned fields
(`alg, id, fingerprint, receiptTx, status, created, validUntil, anchoredBy, receiptAt`, one `k=v` per line).
This is **AGIS network attestation of the seal receipt — not a government, eIDAS or notary signature.**

- Public key: `GET /api/rwa/card-key` (alias `/api/attestation/pubkey`), base58.
- Secret: env `AEGIS_CARD_SIGNING_KEY` = base58 32-byte seed (or 64-byte secret). Set it as a Render secret env var; never commit or log it.
  Generate once: `node -e "import('bs58').then(b=>console.log(b.default.encode(require('crypto').randomBytes(32))))"`
- Without the key, attestation is `unavailable` (no ephemeral key, so signatures stay stable across restarts).
- Tests: `node --test test/attest.test.mjs`

## Stake vault v1 return worker (custodial)
`node stake/return-worker.mjs` = dry run (lists pending returns). `--send` pays ready returns.
- Reads vault + vault-ATA history; FIFO unstake requests capped by stake−returned; pays after LOCK_DAYS (7) from the unstake tx blockTime.
- Memo `AEGIS/return/v1|wallet|amount|ts|unstakeSig` (token.html ledger compatible); skips any unstake already returned (idempotent).
- Fees paid by vault; stops if vault SOL < MIN_SOL (0.005). Never touches mint authority.
- Render Cron Job: same repo/Dockerfile, command `node stake/return-worker.mjs --send`, schedule `0 * * * *`, env `MAINNET=1`, `SOLANA_RPC`, secret `STAKE_VAULT_JSON` (JSON array secret key — never commit).
