Launch fixes · 7 September 2026

This implements the code changes from the launch review. It does not publish the frontend or Convex backend, change deployed settings, submit the hackathon entry, or sign any blockchain transaction. The vault implementation and deployment manifests are unchanged.

**Application changes**

- The wallet picker offers targeted MetaMask and Coinbase Wallet connections, with automatic addition of other injected wallets disabled. MetaMask retains the injected-provider connection used by the original app. Coinbase uses its supported SDK, with app name and icon. Connection errors are visible. The interface restriction is not an onchain wallet-brand restriction.
- Indexed gift IDs now populate the inbox, with amounts, stock, recipient, status, and unlock time read from the vault. Backend pagination is available. A bounded automatic search covers up to 100 older block ranges per request and can be stopped.
- The shared gift page can claim its exact gift through the same receipt-verified claim flow. Deployment write gates still apply. The recipient must connect the correct wallet.
- Plant and Claim state is isolated by wallet, chain, and vault. Writes pin the reviewed account; planting also rejects an account/network change immediately before each wallet request. Claim recovery verifies every requested gift against its transaction receipt.
- Planting repeats conversion, recipient-code, support, pause, balance, minimum, and time checks after approval. Changed terms require another review. The contract still stores raw units, so future multiplier changes can change their share representation.
- A submitted gift retains its note in browser storage, and a confirmed gift with an unsaved note restores its completion screen after a refresh. The record is cleared only after attachment acknowledgement or explicit discard. Recovery expires after 24 hours; expired local text is removed when the record is next read. This is not encrypted storage or background deletion while the browser is closed.
- Review shows the full checksummed recipient address and scrolls it into view before confirmation. Direct gift links keep the selected gift visible instead of hiding it behind the inbox's small-gift filter. Smart wallets are described as contract accounts, not categorically rejected. The copy warns against exchange deposit addresses and states that notes are public.
- Testnet help links to test ETH and the documented deployed stock faucet, lists the test-stock addresses, and explains the normal gift timing. Judges should use an already-unlocked gift to demonstrate claiming without waiting a day.
- Optional `NEXT_PUBLIC_BUILDER_CODE` configuration adds ERC-8021 attribution to approval, planting, and claim requests. No code is invented when it is unset.

**Backend changes**

- Orphaning a creation invalidates its note association. Both note query paths verify creation identity and text commitment. The gift page also checks the plaintext hash against the vault.
- Reorg cleanup queries safe/tip events through the canonicality index before limiting results. It processes at most 500 events per action and retains the old cursor until cleanup finishes.
- Deep recovery can replay from the manifest deployment boundary when all stored checkpoints are invalid. It remains halted during cleanup, remembers the earliest partial-repair boundary, rejects a later boundary that would skip removed data, verifies the reset hash again, and checks remaining events atomically before resuming. Cleanup mutations cannot continue after resumption. The runbook command no longer passes the unsupported `now` argument.
- Monitoring includes manifest stocks, verified/retired catalog assets, and distinct stocks present in gift history. Balance and liability reads share a safe-block snapshot. Missing coverage, unreadable assets, insolvency, and excessive lag fail the monitor run.
- An optional server-only HTTPS alert receiver accepts a JSON incident summary, supports Bearer authentication, rejects redirects, and has a bounded request timeout. Failed delivery is not reported as delivered. The real receiver and notification destination still need configuration and an operational delivery test.

**Verification and deployment tooling**

- Preview and enabled-browser tests build explicit, separate profiles. `npm run build:sepolia` creates the intended Sepolia build with writes enabled, mainnet release disabled, and a required Convex URL. It does not deploy.
- Enabled browser tests exercise the actual app through Coinbase's extension SDK path and the targeted MetaMask connector using test providers and intercepted RPC responses. They cover connection, exact approval, planting, full-address review, direct gift-page claiming, and receipt confirmation. They do not establish real extension/mobile/passkey compatibility.
- CI now includes the enabled wallet flow, native Base tests, and bounded Echidna checks. The mock-dependent Echidna helper is reference-only; the actual native vault tests remain enabled.
- Framing, plugin objects, base URLs, and form destinations are restricted by the enforced CSP. Script/connect policy is report-only for rollout; it is not an enforced executable-script policy.

**Completed verification**

| Check                                                         | Result                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Unit, component, and Convex tests                             | 376 passed across 34 files; coverage gates passed                                                          |
| Preview browser and accessibility suite                       | 60 passed across Chromium, Firefox, and WebKit                                                             |
| Enabled wallet browser flows                                  | Coinbase Wallet and MetaMask both passed approval, planting, and direct claiming with test providers       |
| Solidity reference suite                                      | 140 passed, zero failures                                                                                  |
| Native Base suite                                             | 119 passed, zero failures; 23 reference-only tests skipped                                                 |
| Vault coverage                                                | 100% statements, branches, functions, and lines                                                            |
| Slither                                                       | Existing 12 exact triaged findings validated; no new findings                                              |
| Echidna                                                       | Six properties passed over 2,510 calls                                                                     |
| Dependency audit                                              | Zero known vulnerabilities reported                                                                        |
| Formatting, lint, app/backend types                           | Passed                                                                                                     |
| Catalog, manifests, regenerated bindings, Solidity formatting | Passed                                                                                                     |
| Sepolia release build                                         | Passed; final local build uses the Sepolia profile                                                         |
| Live Sepolia read-only checks                                 | Passed: chain, B20 assets, vault bytecode/version/owner/pause state and stock support matched the manifest |

Wallet configuration was checked against [Coinbase's SDK documentation](https://github.com/coinbase/coinbase-wallet-sdk) and the current [Wagmi Coinbase connector documentation](https://wagmi.sh/react/api/connectors/coinbaseWallet). The SDK supports extension, mobile, and Smart Wallet connections; passing the mocked extension tests does not verify those other real-wallet environments.

**Still required outside this code change**

1. Deploy the updated Convex functions/schema and rebuild/publish the frontend with the intended Sepolia settings. The reviewed public site remains a preview until publication.
2. Supply the registered Builder Code and configure the chosen alert receiver. Validate real notification delivery, not just HTTP acceptance. Configure and test secondary RPC providers. If using CDP event webhooks, configure the signing secret and verify signed delivery; polling-only operation is also supported.
3. Test real MetaMask and Coinbase wallets on the public Sepolia build, including mobile and Coinbase Smart Wallet, using a small test gift and claim. The existing review's real gift was only simulated for claiming.
4. Inspect CSP reports for the actual deployment, then implement and validate the nonce policy before enforcing script restrictions.
5. Confirm hackathon eligibility/deadline, record the public demo, and submit the required entry information. No public messages or submission have been sent.
6. Mainnet still needs the reviewed multisig, production token-policy checks, deployment/source verification, production monitoring/recovery, and independent contract review. Issuer freeze/seizure risk remains intrinsic to these assets.

Local check logs and browser screenshots are in `.cache/launch-review/`. The original findings and live-read evidence remain in `docs/launch-review-2026-09-07.md`.
