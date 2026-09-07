# Sepolia launch checklist

The existing Base Sepolia vault can be reused. The launch fixes do not require a replacement contract. Complete the public testnet release before starting mainnet work.

## 1. Choose the public Convex backend

Use the Convex deployment intended for the public demo. A Convex production deployment can index Sepolia; “production” here describes the backend environment, not the blockchain. Do not assume the development deployment in your local environment is the correct public backend.

Set these in that deployment's Convex dashboard:

| Variable                                   | Value                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `SOWMORROW_DEPLOYMENT_CHAIN_ID`            | `84532`                                                                   |
| `SOWMORROW_INDEXER_ENABLED`                | `true`                                                                    |
| `SOWMORROW_BASE_SEPOLIA_RPC_URL`           | Your server-side Base Sepolia RPC URL                                     |
| `SOWMORROW_BASE_SEPOLIA_RPC_URL_SECONDARY` | A separate provider's Sepolia RPC URL; recommended for provider agreement |
| `SOWMORROW_RETENTION_DAYS`                 | `30`, or your chosen retention period                                     |

Deploy the updated Convex functions, indexes, and schema. For the project's production deployment, the installed CLI supports `npx convex deploy`; verify the displayed deployment target before confirming. Use `npx convex dev` only when intentionally updating a development deployment. If using CI, the private `CONVEX_DEPLOY_KEY` selects the deployment and belongs in the CI secret store.

Let the indexer catch up. Check freshness, failed sync runs, and that the existing gift appears. A new backend can reconstruct onchain gifts, but cannot reconstruct plaintext notes from their hashes; preserve the existing notes if moving backends.

## 2. Configure the frontend host and rebuild

Apply these to the environment serving the public demo URL, not just local `.env.local` or a preview branch:

| Variable                                     | Value                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SOWMORROW_CHAIN_ID`             | `84532`                                                                                   |
| `NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED`       | `true`                                                                                    |
| `NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED`     | `false`                                                                                   |
| `NEXT_PUBLIC_CONVEX_URL`                     | The URL of the backend deployed in step 1                                                 |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL`           | A browser-safe Base Sepolia RPC URL                                                       |
| `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL_SECONDARY` | A browser-safe URL from a second provider; recommended                                    |
| `NEXT_PUBLIC_ETHEREUM_RPC_URL`               | Browser-safe Ethereum mainnet RPC for ENS lookups; recommended if accepting ENS names     |
| `NEXT_PUBLIC_BUILDER_CODE`                   | Your actual registered Builder Code                                                       |
| `SOWMORROW_SITE_URL`                         | `https://www.sowmorrow.app` when the host does not supply the canonical production origin |

Use `npm run build:sepolia` as the build command for this testnet release. Public variables are embedded at build time, so changing them requires a rebuild and redeploy. A Git push may trigger an automatic frontend build, but does not prove the backend or host variables were updated.

Everything named `NEXT_PUBLIC_` is visible to visitors. Use domain-restricted/public RPC credentials there. Private RPC credentials, webhook secrets, deployment keys, and wallet keys must not go in those variables.

No Coinbase API key or WalletConnect project ID is required by the wallet connectors added here. The published `/wallet-icon.svg` must be reachable. Mainnet write variables and mainnet contract settings can wait.

## 3. Set up operator alerts

Choose where incidents should arrive, then provide an HTTPS receiver that converts Sowmorrow's JSON into that notification. The current payload is not a Slack message payload; pasting a Slack incoming-webhook URL directly is insufficient.

Set these on the Convex deployment:

| Variable                           | Value                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| `SOWMORROW_MONITOR_WEBHOOK_URL`    | Your HTTPS JSON receiver URL                           |
| `SOWMORROW_MONITOR_WEBHOOK_SECRET` | Optional shared Bearer secret accepted by the receiver |
| `SOWMORROW_MONITOR_MAX_LAG_BLOCKS` | `1800`, or your chosen threshold                       |

Test a synthetic incident and confirm the actual email/message arrives. HTTP success alone is insufficient. The monitor currently runs daily at 03:00 UTC; choose a shorter cadence before relying on it for timely mainnet incidents.

CDP blockchain-event webhooks are separate and optional for a polling-only release. If using them, configure the subscription for the reviewed Sepolia vault and the backend's webhook route, set `SOWMORROW_CDP_WEBHOOK_SECRET`, and verify signed delivery. Polling still requires `SOWMORROW_INDEXER_ENABLED=true`.

## 4. Verify the public demo

Wait for GitHub CI and hosting deployment checks to pass. On the public site, confirm Base Sepolia is displayed, the two wallet choices are available, and the test-funds help page works.

Use real MetaMask and Coinbase wallets to approve, plant, open a direct gift link, and claim an unlocked gift. Include Coinbase Smart Wallet and mobile. Check account/network switching, rejected signatures, note recovery after refresh, and the full recipient address before confirming. Verify Builder Code attribution in transaction data. Automated wallet tests used simulated providers and do not replace these checks.

New gifts have a minimum waiting period, so prepare an already-unlocked gift for the judges. Use only valueless test stocks on Sepolia.

## 5. Finish browser hardening and the submission

Strict executable-script CSP enforcement is still code work. Configure reporting, review the actual application/wallet connections, and implement and test a nonce-based policy. The current script policy is report-only.

Confirm the organizer's current deadline and whether a Sepolia fixture demo qualifies. Prepare the live URL, demo video, registered Builder Code, entry form, and required X post. Nothing has been submitted by this change.

## 6. Mainnet, last

Obtain an independent contract review, choose and verify the owner multisig, and confirm the vault can receive and send each production stock under the issuer's current policies. Issuer freezes or seizure remain risks that this application cannot remove.

Deploy with the reviewed signer and owner configuration, then verify source and bytecode. Generate the mainnet manifest from the actual broadcast, record the deployment block, and validate stock support and minimums. Configure a dedicated mainnet backend, RPCs, monitoring, and recovery procedures. Preserve Sepolia history separately if retaining the testnet demo.

Only after those checks should the frontend select chain `8453` and enable its mainnet release gate and writes. Do not turn on mainnet by changing environment flags alone. Follow the detailed deployment procedure in `contracts/README.md`.
