# AGIS Claim API

Public mint-claim HTTPS service for [AegisAI](https://aegisai-sol.github.io/aegisai/).

- `GET /api/health`
- `POST /api/claim` — wallet-signed mining claims

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
