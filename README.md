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
