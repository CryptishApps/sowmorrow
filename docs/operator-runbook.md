# Operator runbook

Procedures that touch the Convex mirror or the vault allowlist. Every function below is `internal`, so it can only be run by an operator with deployment access through `npx convex run`, never from a browser.

## Adding or retiring a stock

Two different reviewers must submit the same evidence before a stock is written to `reviewedStocks`. The evidence is the URL of Base's official tokenized-stocks page and the SHA-256 of its content at review time, as recorded in `data/reviewed-stock-catalog.base-mainnet.json`.

1. First reviewer proposes:

```sh
npx convex run catalog:proposeReviewedStock '{
  "chainId": 8453,
  "addressChecksum": "0xb200000000000000000000C2e324d24d7eEcd1fb",
  "symbol": "AAPLc",
  "name": "Apple Inc.",
  "decimals": 18,
  "b20Generation": "beryl",
  "sortOrder": 0,
  "evidenceUrl": "https://docs.base.org/specifications/b20/tokenized-stocks-on-base",
  "evidenceHash": "<content sha256>",
  "reviewer": "<reviewer id>",
  "now": <unix ms>
}'
```

2. Second reviewer approves with the identical `evidenceHash`:

```sh
npx convex run catalog:approveReviewedStock '{
  "chainId": 8453,
  "addressChecksum": "0xb200000000000000000000C2e324d24d7eEcd1fb",
  "evidenceHash": "<content sha256>",
  "reviewer": "<second reviewer id>",
  "now": <unix ms>
}'
```

The approval is rejected if the reviewer matches the proposer, the evidence hash differs, or no proposal exists. Retirement uses the same two-step shape.

3. The vault allowlist is separate and owner-signed. After the mirror row exists, the vault owner (the Safe on mainnet) calls `setSupportedStock(address, true, minAmountRaw)`, where `minAmountRaw` is the stock's launch minimum from the table below. Before that transaction, confirm the vault address is authorised under the stock's transfer sender, receiver, and executor policies, because the vault cannot detect a policy block itself. Record the result with:

```sh
npx convex run catalog:setVaultSupport '{"chainId": 8453, "addressLower": "<address>", "vaultSupported": true, "checkedAt": <unix ms>, "checkedBlock": <block>}'
```

`catalog:upsertReviewedStock` no longer exists.

## Setting or changing a stock's minimum gift amount

Every supported stock carries a non-zero minimum `createGift` amount, `minGiftAmountRaw`, enforced onchain. It exists to make dust-gift flooding costly: below the minimum, `createGift` reverts with `GiftAmountBelowMinimum` before it can consume a gift id or write a log. Raising or lowering it never affects a gift that already exists, so it is always safe to change.

- Enabling a stock (`setSupportedStock(stock, true, minAmountRaw)`) requires `minAmountRaw` in `(0, MAX_MIN_GIFT_AMOUNT_RAW]`. Disabling (`setSupportedStock(stock, false, 0)`) requires exactly `0` and clears the stored minimum; re-enabling later requires a fresh non-zero minimum.
- Changing the minimum on an already-supported stock uses `setMinGiftAmountRaw(stock, amountRaw)`, which reverts if the stock is not supported, `amountRaw` is `0`, `amountRaw` exceeds `MAX_MIN_GIFT_AMOUNT_RAW`, or `amountRaw` equals the current minimum.
- `MAX_MIN_GIFT_AMOUNT_RAW` is `1,000 ether` (1,000 tokens at 1e18 precision). It is a sanity bound against a fat-fingered, practically unusable stock, not a policy ceiling; the owner can always disable a stock outright instead.

The launch minimums below are manual, review-time judgements of roughly five US dollars of stock rounded to a clean fraction of a share, expressed in raw units at 1e18 precision. They are not derived from a price oracle. Update them over time with `setMinGiftAmountRaw` as prices move; the exact table also lives next to the reviewed stock list in `contracts/script/DeploySowmorrow.s.sol`.

| Symbol | Minimum (raw, 1e18) | Minimum (shares) |
| ------ | ------------------- | ---------------- |
| AAPLc  | `0.01 ether`        | 0.01             |
| AMZNc  | `0.01 ether`        | 0.01             |
| COINc  | `0.01 ether`        | 0.01             |
| CRCLc  | `0.01 ether`        | 0.01             |
| GOOGLc | `0.01 ether`        | 0.01             |
| INTCc  | `0.2 ether`         | 0.2              |
| METAc  | `0.01 ether`        | 0.01             |
| MSFTc  | `0.01 ether`        | 0.01             |
| MSTRc  | `0.01 ether`        | 0.01             |
| NVDAc  | `0.01 ether`        | 0.01             |
| SNDKc  | `0.2 ether`         | 0.2              |
| SPCXc  | `0.01 ether`        | 0.01             |
| TSLAc  | `0.01 ether`        | 0.01             |

## Candidate discovery

Every six hours `discovery:scanFactoryCandidates` reads B20 factory creations and quarantines ASSET-variant tokens into `stockCandidates` with their on-chain evidence. Quarantine is not promotion: a candidate never reaches the rail or the vault without the ceremony above. List them with `catalog:listCandidates`.

## Halted indexer

The reconciler keeps up to 64 block checkpoints on its cursor. On a reorg it walks back to the newest checkpoint that still matches the chain, orphans every event above it, rebuilds affected gift projections, and continues. It halts only when no checkpoint survives, recording `failureCode: "reorg_beyond_checkpoints"` in `syncRuns`.

To resume, use a canonical stored checkpoint. If none survives, use the block immediately before the reviewed manifest deployment block to replay the full vault history. Verify the block hash independently before running:

```sh
npx convex run reconciliation:repairHaltedCursor '{"resetToBlock": <block>, "resetToBlockHashLower": "<0x hash>", "operator": "<operator id>"}'
```

The action re-reads the block hash from the primary RPC before resetting. It refuses an active cursor, a block that is neither a stored checkpoint nor the deployment boundary, or a hash that does not match. Cleanup runs while halted. If the result is `cleanup_pending`, repeat the same command until it returns `resumed`; it does not skip remaining cleanup. A partial repair records its earliest cleanup boundary; changing to a later boundary returns `repair_boundary_conflict`. Continue from the recorded boundary or an earlier one. Concurrent cleanup cannot orphan records after the cursor resumes. The ordinary reconciler then rebuilds history from the selected boundary. Keep the mirror marked as catching up until it reaches the safe head. The repair is written to `syncRuns` as an `operator-repair` run.

## Daily signals

`monitor:checkVaultSolvencyAndLag` runs at 03:00 UTC. It records per-stock health signals and fails the run on insolvency, incomplete reads or coverage, RPC failure, or excessive index lag. Liability and balance reads use the same safe block. The optional alert receiver is called for degraded results. This daily schedule is not continuous incident detection. Nothing in the mirror can repair insolvency; it is an incident for the vault owner and the issuer.

`retention:pruneTerminalRecords` runs at 04:00 UTC and deletes terminal webhook deliveries and sync runs older than `SOWMORROW_RETENTION_DAYS` (default 30).

## Environment

Set these with `npx convex env set`, never as `NEXT_PUBLIC_` values:

- `SOWMORROW_CDP_WEBHOOK_SECRET`
- `SOWMORROW_DEPLOYMENT_CHAIN_ID`
- `SOWMORROW_BASE_MAINNET_RPC_URL`, `SOWMORROW_BASE_SEPOLIA_RPC_URL`
- `SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY`, `SOWMORROW_BASE_SEPOLIA_RPC_URL_SECONDARY` (optional; when set, both providers must agree on the safe-head hash before events are promoted)
- `SOWMORROW_INDEXER_ENABLED` (gates historical range backfill only; tip promotion, orphaning, and reorg rewind run whenever a deployment is configured)
- `SOWMORROW_RETENTION_DAYS`
- `SOWMORROW_B20_FACTORY_START_BLOCK` (optional; discovery start, defaults to the manifest deployment block)

## Release profiles and wallet checks

`npm run build:sepolia` loads the local environment, forces Base Sepolia writes on and mainnet release off, and requires a Convex URL. Use the intended public backend and browser-safe RPC credentials when building on the hosting platform. This command builds only; it does not publish.

`npm run test:e2e` builds an explicit mirror-free preview. `npm run test:e2e:enabled` builds a separate Sepolia profile and exercises the Coinbase SDK and targeted MetaMask connector against test wallet providers and intercepted RPC responses. Neither signs a real transaction. Before publishing, verify MetaMask and Coinbase extension/mobile/smart-wallet connections with real wallets on Sepolia.

Set `NEXT_PUBLIC_BUILDER_CODE` to the actual registered Builder Code before the release build. The app appends an ERC-8021 suffix to approval, planting, and claim requests. Leaving it empty adds no attribution. Check the submitted transaction data, including the execution call when using a smart account.

## Alert delivery

The monitor includes manifest stocks, verified/retired catalog stocks, and every distinct stock present in gift history. It reads balances and liabilities at the same safe block. Missing coverage, unreadable assets, insolvency, or excessive lag mark the run failed.

Configure `SOWMORROW_MONITOR_WEBHOOK_URL` with an HTTPS JSON webhook receiver and optionally `SOWMORROW_MONITOR_WEBHOOK_SECRET` for Bearer authentication. The receiver must route the JSON to the intended operator notification channel and return a 2xx status. `SOWMORROW_MONITOR_MAX_LAG_BLOCKS` defaults to 1800. Failed delivery is returned as `alertDelivery: "failed"`; absent configuration returns `not_configured`. Test the receiver and notification delivery before launch. These values are server-only and must never use a `NEXT_PUBLIC_` prefix.

The existing CDP event webhook is separate from operator alert delivery. A polling-only release is supported when range indexing is enabled; signed event delivery and secondary-provider agreement still require their own operational tests.

## Browser policy rollout

Framing, objects, base URLs, and form destinations are restricted by the enforced CSP. Script, style, frame, and connection restrictions are initially report-only. Review violations for the actual RPC, Convex, MetaMask, and Coinbase deployment, configure reporting, then deploy and test a nonce-based script policy before enforcing it. Report-only policy is diagnostic and does not prevent script execution.
