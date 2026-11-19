# Liquidity Vault - Week 13

**Verified on Solana Devnet:** Vault-controlled opening, fee collection, complete closure and out-of-range rebalancing. The independent verifier passed for **25 finalized transactions**, including deployment. All three test positions are now closed.

## Verify the submission in a few minutes

```bash
npm ci
npm run verify:week13
```

No wallet, private key, Anchor build or transaction submission is required for verification. The recorded run also passed with `ANCHOR_WALLET` pointing to a nonexistent file. Read [verification-summary.json](evidence/week13/verification-summary.json) and the transaction links below. Verification was executed at `2026-11-19T17:11:29.505Z` UTC; transaction slots identify historical execution independently of current pool state.

## Assignment and implementation

The [original methodology, page 7](evidence/week13/requirements-page-7.txt), requires administrator-selected bounds, both token contributions with maxima, a Vault-owned position NFT, fee collection, full withdrawal with minima, and a genuine out-of-range rebalance.

| Vault instruction | Official Raydium CPI sequence | Result |
|---|---|---|
| `open_position` | `open_position_v2` with zero liquidity, then `increase_liquidity_v2` | Admin pays rent; Vault supplies both tokens and owns the NFT |
| `collect_position_fees` | `decrease_liquidity_v2` with liquidity zero | Fees enter Vault token accounts; position liquidity remains unchanged |
| `close_position` | Full `decrease_liquidity_v2`, then `close_position` | Both outputs go to Vault, NFT is burned, NFT account and personal position close |

Opening and funding are atomic. The rent payer and token authority are separated because the Vault PDA is a program-owned state account. A failure in either opening CPI rolls back the whole instruction. Withdrawal and NFT closure are likewise one atomic Vault instruction.

```mermaid
flowchart LR
    Admin[Administrator signer] --> Program[Week 13 Vault program]
    Program -->|PDA signed CPI| Raydium[Raydium CLMM]
    Vault[Vault PDA] --> NFT[Position NFT in Vault ATA]
    Vault --> Tokens[Both Vault token accounts]
    Raydium --> Pool[Existing Devnet pool]
    Trader[Separate trader wallet] -->|Genuine swaps| Pool
    Pool -->|Fees and withdrawn principal| Tokens
```

Vault signer seeds are `["vault", token_mint, bump]`. The manager PDA uses `["position", vault_state]` and stores the bound pool, NFT mint, personal-position address, range, liquidity and active flag. Only one position may be active. NFT mint keypairs sign account creation; custody belongs to the NFT token account's **Vault PDA authority**.

## Devnet addresses

| Account | Address |
|---|---|
| Week 13 program | `8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa` |
| Vault PDA / NFT authority | `CsFJDQv7vdBvXvDzEoSqvZQccFZLbYqAJcTeaSjZUfKN` |
| TOKEN_A account | `6ywuuHXGwoXxsMoUufL9BpeLkKGXzohPvrXgxpaLDAyi` |
| TOKEN_B account | `DveZCv2hMWqZ5UbdBQxyp4xC6aZPpofpkN2xTzgghHuZ` |
| Share mint | `GDoh9tMjfVzrUYH7PQxF8KYtfVNkMqay6ELpB8b4e8ET` |
| Position manager PDA | `H4VjkQSzC6fV9NWbf4GyEnyZQ2iFK4hrcrkfbqHJv3Pv` |
| Administrator | `3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7` |
| Separate trader | `8YYWcK5FA79Y9L3PMmWaukgEKbHLq9NXFm4TG5Pn1cgJ` |
| Raydium CLMM | `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` |
| Pool | `EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f` |
| TOKEN_A / token_0 mint | `7bdCcN9agJ3TSSjTFctxM4TGFVecBRd6gLNYoWYyvawF` |
| TOKEN_B / token_1 mint | `CwHVUNisByLqXM7mN47nhtcfG8AkYxeJ3tBdFB66yZAt` |

Both mints are ordinary SPL tokens with **six decimals**. Full derived addresses are in [addresses.json](evidence/week13/addresses.json). Deployment used a new 604,864-byte program and exact-size allocation; [deployment receipt](https://explorer.solana.com/tx/31oM1gN5Wjzxqd3CaPKpftoLEfXq5xEsEEwPj7NDMrN3SD24W8Cyn9Ypz36vP58NtrepPuCPpMCTYee9uLKJmqZW?cluster=devnet). The verifier compares the deployed ELF against SHA-256 `e6712608e22f254b87a2c48f881ce0502cc6cde62a79bd507d6eae9dd112f666` and checks the loader deployment, slot and upgrade authority.

## Chosen ranges and opening amounts

Price is **TOKEN_B per TOKEN_A**. With equal decimals, a tick boundary is `1.0001^tick`, and execution price is `sqrt_price_x64^2 / 2^128`. Prices below are rounded to 12 decimal places; exact sqrt prices are preserved in the verification summary. Tick spacing is 60. The upper range boundary is exclusive.

| Position | Tick range | Price bounds | Actual opening price | Liquidity | A contributed | B contributed |
|---|---|---|---|---|---|---|
| Normal | `-720 .. 480` | 0.930534245505 .. 1.049168137486 | 0.989738741819 | `661942349` | 19.119261 | 20.000000 |
| Old rebalance | `-180 .. -60` | 0.982161916245 .. 0.994018262239 | 0.989689211777 | `5276455704` | 11.562049 | 20.000000 |
| Replacement | `-840 .. 360` | 0.919435117457 .. 1.036653980636 | 0.981611022806 | `627135103` | 17.033840 | 20.000000 |

Every opening capped contributions at **20.000000 A and 20.000000 B**. Normal and replacement ranges extend 600 ticks around an aligned center, approximately 6% on each side. The old rebalancing position uses a narrower 120-tick total range so a genuine crossing can be demonstrated with modest test-token swaps.

LP token composition changes with price because CLMM liquidity exchanges one asset for the other inside its range. Below the lower bound it holds token_0; above the upper bound it holds token_1. Rebalancing closes an inactive range and opens a new one around the changed price.

## Normal lifecycle and fees

Setup deposited **200.000000 A** with shares. A Vault-signed swap exchanged 100.000000 A for **98.981011 B**. The normal position then contributed the amounts above. The separate trader executed A-to-B, B-to-A and A-to-B swaps of one token each. All three swaps were finalized between opening and fee collection, and their signer, pool and exact token flows are independently checked.

The fee collection removed **zero liquidity** and retained the full **661,942,349** position liquidity until closure. Raydium's own events independently separate principal from trading fees:

| Collection action | Fees A | Fees B |
|---|---|---|
| normal-collect | 0.000070 | 0.000035 |
| normal-close | 0.000000 | 0.000000 |
| rebalance-old-close | 0.042706 | 0.000000 |
| rebalance-new-close | 0.000000 | 0.000000 |
| **Total across Week 13 positions** | **0.042776** | **0.000035** |

The normal explicit collection earned **0.000070 A and 0.000035 B**. Additional rebalancing fees were collected as part of closing the old position; they are included in that close's returned amount, not counted again as principal. See [fee evidence](evidence/week13/fee-collection.json) and [verified deltas](evidence/week13/balance-deltas.json).

## Closing: exact returned amounts

All amounts are exact six-decimal token quantities. Returned amounts include any fees collected during the close; principal is listed separately. The minima apply to Raydium's principal withdrawal, with an additional Vault balance-delta check.

| Close | A returned | B returned | Principal A | Principal B | Minimum A / B |
|---|---|---|---|---|---|
| [normal-close](https://explorer.solana.com/tx/3LX5jAqgy7aqNSjptmUTcJb3dNvybeBTPgFJi27JqmQp1zDbrQwngcAWQavukBETunAasFmAp8moxNxBTcv8U7fE?cluster=devnet) | 19.135909 | 19.983521 | 19.135909 | 19.983521 | 18.944549 / 19.783685 |
| [rebalance-old-close](https://explorer.solana.com/tx/3EKyy91a98fXnxbFNuGaWhs66nwyDi4Hn9khnbQT4FdHFTrKsHMUygnqj5177YLqDaQBcG26U6V5f4Wa4n6Vt3r9?cluster=devnet) | 31.890409 | 0.000000 | 31.847703 | 0.000000 | 31.529225 / 0.000000 |
| [rebalance-new-close](https://explorer.solana.com/tx/4A2AiSBY9wLRn5U9DLV8ETJbRLEjS9UvUEM4raBLoaWiFhSPEGVBibpAYYC2qBidFJTf8h8kzygpidJkb7mCcd8v?cluster=devnet) | 17.033839 | 19.999999 | 17.033839 | 19.999999 | 16.863500 / 19.799999 |

After replacement cleanup, the transaction's observed Vault balances were **120.345077 A and 78.964566 B**. Both assets remain controlled by the Vault; single-token withdrawals remain locked.

| Position | NFT mint | Vault-owned NFT account | Independently verified final state |
|---|---|---|---|
| normal-open | `BGMmyTvtEzND3uR2ef5FQszHt82xjBhfEfXCytXJGAoy` | `ECbfDWCnxMAZ86j49cYLMwECcN7YXFndcweCo5Yfx7Dr` | Supply 0; NFT account and position closed |
| rebalance-old-open | `EVfhb1eYwmP8YAstSFUTmNMSSvFfzS58H6iSERrWVijd` | `6r3XmRtwcom6E84m18g7eN5SUMNfVBsNQeQU7fqVfK7U` | Supply 0; NFT account and position closed |
| rebalance-new-open | `2wkmWUqhUHXqqsRxHHSYjXstS9DgD2fgi3qM7H5tWpUc` | `DJLMJNQXWMW8vDkD4wtqSvdU9aDRHukf6S9iq9t1sEvg` | Supply 0; NFT account and position closed |

Ordinary SPL NFT mint accounts remain with supply zero after burning. Historical custody is established from finalized initialization/minting and Vault-authorized CPI; the verifier separately checks current closure. [NFT evidence](evidence/week13/position-nfts.json).

## Rebalancing proof

Nine real swaps of **20.000000 A each** moved the price outside the old range `[-180, -60)`. At the actual old-close instruction, Raydium and Vault events both recorded **tick -186**, price **0.981611022806**, below the lower bound. The old NFT was burned. The replacement opened at tick **-186** in range **[-840, 360)**, with a new Vault-owned NFT and positive contributions of both tokens. Its subsequent cleanup also withdrew everything and burned that NFT.

Out-of-range closing legitimately returned zero B because the old liquidity was entirely in A. Its B minimum was explicitly zero and its A minimum was positive. [Rebalancing evidence](evidence/week13/rebalancing.json).

## Security, accounting and limits

- Every management operation checks the administrator signer, canonical Vault/config/manager PDAs, pool binding and Raydium program identity.
- Mint pair, source/destination authorities, NFT mint and holder, canonical personal position and tick-array addresses are checked. NFT delegates and alternative close authorities are rejected.
- Ticks must be ordered, in bounds and aligned. Opening requires an in-range price, positive bounded liquidity and positive actual contributions of both tokens.
- Maximum inputs, minimum outputs, checked integer deltas, stored liquidity and duplicate/invalid lifecycle transitions are enforced. State advances only after successful CPIs and custody checks.
- `strategy_active` stays true after collection and closure. `total_tokens` tracks idle A, not two-token portfolio NAV; share supply is preserved. Withdrawal restoration is not implemented: safe restoration requires closing positions, converting B back to A and reconciling accounting.
- Supported scope is the selected ordinary SPL-token pool without reward emissions. It must remain without rewards while positions are live. Generic reward-bearing and Token-2022 asset support is outside this submission.
- [Dependency audit](evidence/week13/dependency-audit.json) reports 19 inherited Node dependency advisories (9 moderate, 10 high). The Anchor/Raydium-compatible versions remain pinned. This is a Devnet academic submission; the audit is not a claim of production certification.
- The independent verifier sends no transactions and reads no wallet. Standard RPC cannot retrieve arbitrary historical account bytes. Stored preflight/balance reads are labeled observations; finalized transaction metadata, CPI instructions and attributed events establish historical effects.

## Fresh checks

| Command / check | Result | Evidence |
|---|---|---|
| `cargo fmt --check` | Passed | [log](evidence/week13/format.txt) |
| `cargo check --workspace` | Passed | [log](evidence/week13/cargo-check.txt) |
| `cargo test --workspace` | Passed (5) | [log](evidence/week13/rust-tests.txt) |
| `anchor build` | Passed | [log](evidence/week13/anchor-build-recovered.txt) |
| `npm run typecheck` | Passed | [log](evidence/week13/typecheck.txt) |
| `npm run test:unit` | Passed (6) | [log](evidence/week13/slippage-unit.txt) |
| `npm run test:week13` | Passed (8) | [log](evidence/week13/week13-unit.txt) |
| `npm run test:local` | Passed (17) | [log](evidence/week13/local-tests.txt) |
| `npm run test:week13:local` | Passed (11) | [log](evidence/week13/clmm-local-tests.txt) |
| `Week 13 deployed-program negative RPC simulations` | Passed (44) | [log](evidence/week13/manifest.json) |
| `npm run verify:week13 (invalid ANCHOR_WALLET)` | Passed (25) | [log](evidence/week13/verification.txt) |

The **44 negative checks are RPC simulations of the deployed Devnet program**, not 44 failed on-chain transactions. They cover unauthorized open/collect/close, invalid pool/position/ticks/NFT custody, maxima/minima, zero liquidity, duplicates and withdrawal locks. The 17 legacy integration tests and 11 genuine Raydium CPI integration tests ran on isolated local validators; their results are distinct from Devnet evidence.

## Reproduce builds and tests

Use Node 22, Anchor 0.31.1, the Solana CLI and Rust; exact versions and source hashes are in [build-artifact.json](evidence/week13/build-artifact.json).

```bash
npm ci
cargo fmt --check
cargo check --workspace
cargo test --workspace
anchor build
# Restore the public client IDL address for this recorded deployment.
cp evidence/week13/program-idl.json target/idl/simple_vault.json
npm run typecheck
npm test
npm run preflight:week13
npm run verify:week13
```

For legacy local tests, load this branch's program into a separate validator and set `ANCHOR_PROVIDER_URL=http://127.0.0.1:18899` and `ANCHOR_WALLET` before `npm run test:local`. The CLMM fixture test clones public Devnet accounts; it never writes to Devnet:

```bash
node --no-experimental-strip-types -r ts-node/register scripts/week13-local-fixture.ts
mapfile -t CLONE_ACCOUNTS < <(node -e "require('./evidence/week13/local-fixture.json').accounts.forEach(x=>console.log(x))")
solana-test-validator --ledger /tmp/week13-clmm-reproduction --rpc-port 18899 \
  --faucet-port 19900 --dynamic-port-range 19000-19050 \
  --url devnet --mint 3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7 \
  --bpf-program 8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa target/deploy/simple_vault.so \
  --clone-upgradeable-program DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
  --clone "${CLONE_ACCOUNTS[@]}"
# In a second terminal, using the matching source wallet for the cloned token accounts:
ANCHOR_PROVIDER_URL=http://127.0.0.1:18899 WEEK13_CLMM_LOCAL=1 npm run test:week13:local
```

The original deployment command used the ignored new Week 13 keypair and an explicit ignored buffer:

```bash
solana program deploy target/deploy/simple_vault.so \
  --program-id target/deploy/simple_vault-keypair.json \
  --buffer target/deploy/week13-buffer-keypair.json \
  --max-len 604864 --url devnet --use-tpu-client --output json
```

Do not redeploy to reproduce verification. A fresh independent deployment needs a new program keypair, synchronized Anchor/Rust IDs and updated expected Week 13 IDs in the scripts; the recorded program is deliberately protected against accidental targeting of previous weeks.

The actual scenario commands were:

```bash
npm run week13:run -- setup
npm run week13:run -- normal
npm run week13:run -- rebalance
npm run week13:run -- cleanup
```

The runner checkpoints each signed signature **before broadcast**, finalizes it before recording success and resumes completed phases. `npm run week13:run -- recover` resolves a pending checkpoint before any retry. LP contributions are capped at 20 tokens per side; rebalancing is capped at twelve 20-A swaps and needed nine. Private keys and caches remain ignored.

## Finalized transaction links

All 24 scenario signatures and the deployment below were independently fetched at finalized commitment. Full signatures, instructions and compact results are in [manifest.json](evidence/week13/manifest.json) and [verification-summary.json](evidence/week13/verification-summary.json).

| Action | Slot | Transaction |
|---|---|---|
| Deployment | `523896183` | [deployment](https://explorer.solana.com/tx/31oM1gN5Wjzxqd3CaPKpftoLEfXq5xEsEEwPj7NDMrN3SD24W8Cyn9Ypz36vP58NtrepPuCPpMCTYee9uLKJmqZW?cluster=devnet) |
| initialize-vault | `523896854` | [Explorer](https://explorer.solana.com/tx/5ZzZHiiWuuKdFsYXyz6RNxGjqUpjj4HduWhtdSuBqnxXEnZMVvB9gCyGvazxcRrEvTBN1HDAywKUfXAfz86sMJ9w?cluster=devnet) |
| initialize-swap | `523896861` | [Explorer](https://explorer.solana.com/tx/3Wt7hjkTN6LjExthmd8Uo2VooYRRzAHKeWgwEoEcKAB2WfJU8pCyqJZcbGf2przcqh5esFGoLBYJPeMxxDJmn3XD?cluster=devnet) |
| fund-trader | `523896872` | [Explorer](https://explorer.solana.com/tx/3MYqsWrU52zu6ehUDnnpBYwgQRHgtzmxbJbSrybqanEmN5FsUYj4jfZFeAYJzgqRXydzipJKnL6kBA8os1MTCPYS?cluster=devnet) |
| deposit | `523896880` | [Explorer](https://explorer.solana.com/tx/5cS53piuxwzoNp8RK5ZEb4iWiNwtdRy8s6DsC1wFmAuBqSSyfGWCyZoY5BQtbiYGq4t1vL8NMe2mLsbZjnqegN2j?cluster=devnet) |
| prepare-vault-token-b | `523896901` | [Explorer](https://explorer.solana.com/tx/51QEF3rJHMEKP76R1PYJoX6QSLchDGTEYPtRherzVZjPZWMNheC7RDJNVjH8JfSd49CABsVXq8ZEf4gE4PSMoMmv?cluster=devnet) |
| normal-open | `523897041` | [Explorer](https://explorer.solana.com/tx/5EKaaMGb8WZQP9X39qzSU4zxXXHpGkSUHh7wMRCaSb2gbWAuBd4unxZ5tjv4f192gmRNgjxqh7MrTcnGQZXqT6cV?cluster=devnet) |
| normal-swap-1 | `523897078` | [Explorer](https://explorer.solana.com/tx/4iw3QkQ9fQ9LLuwPpCr7FCyNJuFcp2wyq2PLFvGkfDzmJ3xq5Te7L59zNv8uHP2Asvw6LApoGKUUcjR9bD1rZxYt?cluster=devnet) |
| normal-swap-2 | `523897092` | [Explorer](https://explorer.solana.com/tx/5bimyKi4TkFFYaLPnjmtuRBGwy6ZoLsqeQc6a7gnmv9qSVfmgu3QgGhi52pVbMbpKWipDRbiSagQCvtArNtDpYDv?cluster=devnet) |
| normal-swap-3 | `523897110` | [Explorer](https://explorer.solana.com/tx/4XZAcYrGooJexfGkLRsVRQHkCtN1a1UpQBNN5ggF6S1Tgo5QNzM742vyRAve1US8kdrQjAGL454cFYHYWCWjHbHU?cluster=devnet) |
| normal-collect | `523897122` | [Explorer](https://explorer.solana.com/tx/5PMwYAdNNzFj8KNjbDcLoxjsk6QpifT3Y5MJC4tEya4baqhnSaQbQrtpppU24xjq4CY9p96s3ggR2vAec8fHfnbK?cluster=devnet) |
| normal-close | `523897144` | [Explorer](https://explorer.solana.com/tx/3LX5jAqgy7aqNSjptmUTcJb3dNvybeBTPgFJi27JqmQp1zDbrQwngcAWQavukBETunAasFmAp8moxNxBTcv8U7fE?cluster=devnet) |
| rebalance-old-open | `523897287` | [Explorer](https://explorer.solana.com/tx/4T6QHDWSKyuRBaUenXeMWXhr36E3cN6NZ7JYbqep2diNhkUi77UhRqYisf42SXXVhrwaQtxFg5bonViKeMDnp6rN?cluster=devnet) |
| rebalance-move-0 | `523897324` | [Explorer](https://explorer.solana.com/tx/328XJc5ZtAJPLzeFpBZ5nBkRVBftzZ1diRvbMHfkH27AvivPTFmoEwDqdVmLKaSo7eS6cETDgqLiJokiKs8TUMLz?cluster=devnet) |
| rebalance-move-1 | `523897338` | [Explorer](https://explorer.solana.com/tx/55PBkx2EnGjD4wRTXe1jUeMm216pRKVzVsrGkDFnbfoGS49LtqSUvQeDGeoT51qmF4mz6VKMXKN93BS5BbK8Jchp?cluster=devnet) |
| rebalance-move-2 | `523897356` | [Explorer](https://explorer.solana.com/tx/3nq3hkNGzmcmFEg2xDHYthbfmsnkwXJQaBLqXNK2JgP9ECwL5iNHmNacncJxRRJabBYCaMwXLKEhaNk6bzTjTXf7?cluster=devnet) |
| rebalance-move-3 | `523897373` | [Explorer](https://explorer.solana.com/tx/2QxQWVK83Zg3t78JpRJMjYzTAKeS9oKK5FBeV4LTBC3vPEqe6jY3c81LxLLzHSnCJqp3PsGr9B7HrS744uoAxzCe?cluster=devnet) |
| rebalance-move-4 | `523897394` | [Explorer](https://explorer.solana.com/tx/3a341aUke4jtrLGH9wG5GQfXFdPJdUT7TsY3mRPSxzRRHJoC2zTE7RrHQAppkaF7E1sVas3pi8BH4YCShR51YNj?cluster=devnet) |
| rebalance-move-5 | `523897414` | [Explorer](https://explorer.solana.com/tx/4kn63cSKWb3YsEiZKwnnBP16wXbyLvhCckEwUFMh8CJi6jfihNcJr93wqBDudVxMsWGzFnB2KbjxC76eNbSWYpYa?cluster=devnet) |
| rebalance-move-6 | `523897438` | [Explorer](https://explorer.solana.com/tx/5FMG3h2Ag3s1YL59tcLMZwMCryoyJuvE2iTGMAwokVRn8LecpbYfrbRmfWNoHrUgmrHheMj13xSXYnUXzxCJFvKY?cluster=devnet) |
| rebalance-move-7 | `523897457` | [Explorer](https://explorer.solana.com/tx/J5WMzdz5svwvCfgWrmzuxC5yy6WsCFCzEVskxEAGuwRWWqCqh9J13LK3CcuPMtfhTTMdqkW7yBjY7zP1M2CJFmf?cluster=devnet) |
| rebalance-move-8 | `523897479` | [Explorer](https://explorer.solana.com/tx/25xWVBnVzPRLWkhbW2BETEEGktSZ6uNi1ppCkQwbfLmtZgzsR1MJQ317CAy21SphDJj6NHxbiTvZAdqd2b8WgmM6?cluster=devnet) |
| rebalance-old-close | `523897500` | [Explorer](https://explorer.solana.com/tx/3EKyy91a98fXnxbFNuGaWhs66nwyDi4Hn9khnbQT4FdHFTrKsHMUygnqj5177YLqDaQBcG26U6V5f4Wa4n6Vt3r9?cluster=devnet) |
| rebalance-new-open | `523897531` | [Explorer](https://explorer.solana.com/tx/63rFT7FahY3eJgTJsRZZgqJ5ZZRf3Tu9gRE6cewAunjTw259vRxBzJxpAAVskq2FJBvFJHnQLodYKc3S2Da3vgEP?cluster=devnet) |
| rebalance-new-close | `523897643` | [Explorer](https://explorer.solana.com/tx/4A2AiSBY9wLRn5U9DLV8ETJbRLEjS9UvUEM4raBLoaWiFhSPEGVBibpAYYC2qBidFJTf8h8kzygpidJkb7mCcd8v?cluster=devnet) |

## Requirements-to-evidence checklist

| Methodology requirement | Verified evidence |
|---|---|
| Administrator selects bounds; both tokens supplied with maxima | Three open transactions; exact range/input table; maximum-input rejection simulations |
| Vault controls the NFT | Finalized SPL initialization/minting; Vault-signed increase/decrease CPIs; NFT custody evidence |
| Collect trading fees | Normal collection plus Raydium fee events and exact verified deltas |
| Withdraw all liquidity with minima; close NFT | Three closes; full matching liquidity; burn/close instructions and current supply-zero checks |
| Administrator-only operations | Unauthorized open, collect and close simulations; local CPI tests |
| Official compatible Raydium CPI | Pinned interface and actual nested CPI discriminators/account bindings |
| Open ? other-wallet swaps ? collect ? close | Normal scenario with three signed trader swaps and ordered finalized slots |
| Move price outside ? close ? reopen | Nine swaps; actual close tick -186 outside [-180,-60); replacement [-840,360) |
| Document range, fees and exact token returns | Tables above; independent events and balance-deltas evidence |
| Safe withdrawal accounting | Persistent strategy lock; share accounting tests; no unsafe restoration |
| Independent wallet-free verification | Successful public-RPC verifier with invalid wallet path; ELF/hash/authority/transaction checks |
| Preserve previous weeks | Isolated branch/directory and new program ID; original README in [README-WEEK12.md](README-WEEK12.md); isolation audit |

## Isolation and official sources

The public [Anchor IDL](evidence/week13/program-idl.json) is included for clients and local reproduction. A fresh `anchor build` may generate a different local keypair and IDL address; restoring this public IDL preserves the recorded address without distributing any signing key. The independent verifier does not use this IDL. See the [final security/isolation audit](evidence/week13/security-audit.json).

This work starts at `origin/week-12-submission` commit `b3446244d017cd807dfc280eb0b8c4defd4729d7` on `week-13-submission`. Previous branches, programs and historical evidence are preserved. Required swaps intentionally change the shared test pool's price. All new evidence lives under `evidence/week13/`.

- [Official Raydium CPI examples](https://github.com/raydium-io/raydium-cpi-example/tree/master/clmm-cpi/programs/clmm-cpi/src/instructions).
- [Pinned public program interface](https://github.com/raydium-io/raydium-clmm/blob/d4ec101534724a20e1eb38a9b997f8b391c5100f/programs/amm/src/lib.rs), revision `d4ec101534724a20e1eb38a9b997f8b391c5100f`.
- [Pinned position opening implementation](https://github.com/raydium-io/raydium-clmm/blob/d4ec101534724a20e1eb38a9b997f8b391c5100f/programs/amm/src/instructions/open_position.rs).
- [Pinned decrease/fee implementation](https://github.com/raydium-io/raydium-clmm/blob/d4ec101534724a20e1eb38a9b997f8b391c5100f/programs/amm/src/instructions/decrease_liquidity.rs).

The public CPI argument order is taken from the pinned `lib.rs`, which differs from its internal helper order. Wallet-owned SDK liquidity operations are not used as proof of Vault CPI functionality.
