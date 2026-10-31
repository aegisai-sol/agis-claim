# AGIS Claim API

Public mint-claim HTTPS service for [AegisAI](https://aegisai-sol.github.io/aegisai/).

- `GET /api/health`
- `POST /api/claim` — wallet-signed mining claims

**Secrets (host env only, never commit):**
- `MINT_AUTH_JSON` — mint authority keypair JSON array
- `MAINNET=1`
- optional `SOLANA_RPC`

Mint: `GhSiU95vtKwn7FBAW1u5krxYP2PnpFPotb1LJFZkbzhW`
