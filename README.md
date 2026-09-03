> Built for the Base Builder Quest.

# Sowmorrow

Sowmorrow turns Coinbase tokenized stocks on Base into time-locked gifts. A sender plants stock for another address, chooses an opening date, and only the recipient can claim it once that date arrives.

The app starts in a safe read-only preview. Wallet writes remain unavailable until the selected chain has a verified vault deployment, and Base mainnet has an additional release gate. No public vault is deployed yet; the checked-in mainnet and Sepolia manifests are intentionally pending.

## Features

- A single-screen Plant/Claim experience, responsive gift pages, and accessible keyboard, touch, and drag controls.
- A reviewed catalog of 13 Coinbase tokenized stocks documented by Base.
- Injected-wallet and Coinbase Wallet connections, chain switching, Base name resolution, exact raw/scaled amount conversion, immutable transaction review, contract-recipient warnings, and submitted-transaction recovery through a secondary RPC.
- Individual and batch claims, grouped inbox state, and onchain minimum gift amounts that make dust flooding costly.
- A non-upgradeable `SowmorrowVault` with B20 validation, exact liability accounting, creation-only pausing, two-step ownership, and no cancellation or recovery backdoor.
- Base mainnet, Base Sepolia, and local manifests with deterministic contract bindings and a pinned Base-native development stack.
- A signed CDP webhook endpoint and a receipt-verified Convex mirror with reorg handling, provider agreement, stock quarantine and review, solvency monitoring, and retention pruning.
- Vitest, Playwright, Axe, Forge unit/fuzz/invariant/adversarial tests, Slither, Echidna, and continuous integration.

## Requirements

- Node `>=22.12.0` and npm `11.14.0`
- Foundry `1.8.1`
- Docker for the pinned native Base test lane
- `uv` for the locked Slither environment

Install exact npm dependencies and create local configuration:

```sh
git submodule update --init
npm ci
cp .env.local.example .env.local
npm run dev
```

The app is then available at the URL printed by Next. With the example values it stays in Base mainnet preview mode and cannot request a signature.

## Verification

Run the application, backend, generated-binding, manifest, and production-build checks:

```sh
npm run check
```

Run every local release lane, including production browser tests and contract security tools:

```sh
npm run verify
```

The full command requires Docker and `uv`. Individual contract commands are documented in [contracts/README.md](./contracts/README.md).

Read-only network checks never broadcast:

```sh
BASE_MAINNET_RPC_URL=https://mainnet.base.org npm run contracts:check-network -- base-mainnet
BASE_SEPOLIA_RPC_URL=<rpc-url> npm run contracts:check-network -- base-sepolia
```

## Configuration and deployment

Use [.env.local.example](./.env.local.example) as the complete field list. Browser-safe values go in the frontend host. Webhook secrets and authenticated indexer RPC URLs belong in the Convex environment and must never use the `NEXT_PUBLIC_` prefix.

A Sepolia or mainnet release needs a funded deployment account, a reviewed owner configuration, an active deployment manifest generated from the broadcast result, a configured Convex deployment, and a CDP webhook subscription. Mainnet additionally requires a reviewed Safe, issuer-policy checks for every stock, contract and source verification, and an explicit release decision before writes are enabled.

See the [operator runbook](./docs/operator-runbook.md) for stock review, allowlist, indexer repair, monitoring, and backend environment procedures. Contract guarantees, risks, and deployment commands are documented in [contracts/README.md](./contracts/README.md).

## Key paths

- `components/gift-widget.tsx`, `components/claim-inbox.tsx` — Plant and Claim UI and state
- `components/stock-rail.tsx` — the 13-stock selector
- `app/gift/[chainId]/[vault]/[giftId]/` — gift detail route
- `lib/contracts/` — generated ABIs, manifest parser, transaction flows, error mapping, pending-submission recovery
- `contracts/src/SowmorrowVault.sol` — escrow contract; `contracts/test/audit/` — adversarial audit suite
- `contracts/src/fixtures/`, `scripts/local/` — test faucet, fixture deployment, local Base node stack
- `convex/` — mirror: webhook, reconciliation, discovery, notes, monitor
- `docs/operator-runbook.md` — stock review, indexer repair, daily signals, and backend environment
- `e2e/` — production browser and accessibility checks
