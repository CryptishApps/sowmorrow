# SowmorrowVault

`SowmorrowVault` holds Base B20 tokenized stocks as time-locked gifts. A sender deposits a raw token amount for one recipient and one unlock time. From that time on, the recipient, and nobody else, can withdraw it.

The whole contract is 421 lines of Solidity 0.8.36 in [src/SowmorrowVault.sol](./src/SowmorrowVault.sol), with NatSpec on every function, event, and error. Read the source before this file; this file explains the choices the source cannot.

## What it guarantees

- A gift's recipient, stock, amount, and unlock time never change after creation.
- Only the recipient can claim, and only at or after `unlockAt`.
- Deposits and payouts must move the vault's balance by exactly the gift amount. Fee-on-transfer, rebasing, or under-delivering tokens revert.
- Only initialized B20 `ASSET` tokens with 1e18 precision and a non-zero multiplier can join the allowlist, and the check reruns every time a stock is re-added.
- Every supported stock carries a non-zero minimum gift amount, `minGiftAmountRaw`. `createGift` reverts below it. The owner sets it when a stock joins the allowlist and can raise or lower it afterward with `setMinGiftAmountRaw`, bounded by `MAX_MIN_GIFT_AMOUNT_RAW`; changing it never touches a gift that already exists.
- Amounts are stored in raw units. A stock split changes the multiplier, not the raw balance, so the payout stays exact.
- Pausing creation or removing a stock from the allowlist never blocks an existing claim.
- `claimMany` settles up to 20 gifts atomically: one bad id and nothing pays out.
- Ownership uses OpenZeppelin `Ownable2Step` and cannot be renounced.
- No proxy, no delegatecall, no cancel, no reassignment, no owner withdrawal, no rescue, no ETH handling.

Before the per-stock minimum, anyone could push arbitrarily many gifts of a single raw unit at a recipient for free: each one consumed a gift id and a `GiftCreated` log without moving anything of value, degrading the claim inbox without bound (see `test_H1_dustGiftFloodDoesNotBlockOnchainClaims` and `test_H2_perStockMinimumRejectsDustAmountsThatUsedToFloodForFree` in [test/audit/AuditBatchGriefingEvents.t.sol](./test/audit/AuditBatchGriefingEvents.t.sol)). A meaningful minimum does not stop flooding outright, but it turns the cost of each dust gift from zero into the minimum itself, so flooding a recipient now costs the attacker real, non-recoverable capital per gift. The launch minimums are review-time judgements, not oracle-derived, and are documented per stock in [DeploySowmorrow.s.sol](./script/DeploySowmorrow.s.sol) and `docs/operator-runbook.md`.

## What it deliberately does not guarantee

The vault cannot protect a gift from the issuer of the stock it holds. This is the largest risk in the design and it is not fixable inside the contract.

- If the issuer's transfer policy blocks the vault as a sender, every gift of that stock is frozen until the policy changes. The gift state stays intact, so claims resume when the block lifts.
- If the issuer pauses transfers, both creation and claims stop, and resume cleanly.
- If the issuer seizes tokens from the vault (`burnBlocked`), `totalEscrowed` for that stock exceeds the real balance. Gifts then pay out first come, first served until the balance runs out, and the remainder can never be paid. Nothing in the contract detects this.
- If the issuer's executor policy blocks the vault, `createGift` reverts because the vault is the transfer executor. Claims are not executor-gated.

Before allowlisting a stock, confirm the vault address is authorized under that stock's sender, receiver, and executor policies, and record the check in the deployment evidence. The backend monitors `totalEscrowed` against vault balances daily and records an insolvency signal, but it cannot repair one.

Two more consequences of having no rescue path:

- A gift sent to the wrong address, or to a contract that cannot call `claim`, is lost. The interface warns when a recipient has code and asks for an extra confirmation.
- Tokens sent straight to the vault, and ETH forced into it, stay there forever.

I would rather own these than add an admin recovery function. Any recovery surface would turn "the code is the custodian" into "the owner key is the custodian", and that is a different product.

## Test evidence

The reference lane runs against `base-std` mocks with adversarial token doubles:

```sh
npm run contracts:test
```

That is 59 unit, fuzz, and adversarial tests, a 512×128 stateful invariant campaign, and the 41-test adversarial audit suite in [test/audit/](./test/audit/). The audit suite covers issuer policy and seizure, cross-function reentrancy through a callback token, every owner power, batch atomicity, dirty-high-bit calldata, memo handling, multiplier changes in both directions, event ordering, and the per-stock minimum's effect on dust-gift flooding. Each test either demonstrates a failure the design accepts or refutes an attack.

The native lane runs the same contract against the real Base precompiles inside the digest-pinned `ghcr.io/base/base-anvil` image:

```sh
npm run contracts:test:native
```

Sixteen reference-only tests skip there because they replace the token runtime; the native lane says so explicitly rather than substituting.

Coverage, Slither, and Echidna:

```sh
npm run contracts:coverage
npm run contracts:slither
npm run contracts:echidna
```

Slither runs the full first-party detector set. Only the fingerprints justified in [security/slither-triage.md](./security/slither-triage.md) pass the report checker. Echidna runs a deterministic six-property campaign against the real vault with a 2,500-test limit. Its isolated compile enables contract metadata so Echidna can identify constructor-deployed contracts; production builds remain metadata-free. The wrapper also turns an internal fuzzer crash into a failed command even when Echidna returns a zero exit code. Forge's invariant campaigns are the long-run property evidence.

One caveat on the invariant names. `invariant_vaultBalanceAlwaysCoversRecordedLiability` and `echidna_vault_is_solvent` hold because no handler models issuer seizure. Read them as "solvent absent issuer action".

## Toolchain

- Foundry `1.8.1`
- Solidity `0.8.36`
- `forge-std` `1.16.2`
- `base-std` `1.0.0` (Beryl)
- OpenZeppelin Contracts `5.6.1`

Exact commits, archive hashes, and the native image digest are in [toolchain.lock.json](./toolchain.lock.json).

## Deployment

[script/DeploySowmorrow.s.sol](./script/DeploySowmorrow.s.sol) accepts chain IDs `31337`, `84532`, and `8453` only. Mainnet requires a Safe owner, the reviewed 13-stock constructor list paired with the reviewed per-stock minimums in `reviewedMinGiftAmountsRaw()`, and `SOWMORROW_START_PAUSED=true`. Test networks require explicit, valueless fixture addresses in `SOWMORROW_STOCKS` with a same-length, same-order `SOWMORROW_MIN_AMOUNTS_RAW`; production company addresses are never reused there.

Simulate without `--broadcast`:

```sh
SOWMORROW_OWNER=<owner> \
SOWMORROW_START_PAUSED=true \
forge script --root contracts \
  script/DeploySowmorrow.s.sol:DeploySowmorrow \
  --rpc-url "$BASE_MAINNET_RPC_URL" \
  --sender <funded-operator-address>
```

Add `--broadcast` only after the security review, signer-policy review, funded-account check, and explicit deployment decision are complete. After a deployment, generate the manifest from the broadcast output rather than typing addresses, record the deployment block, regenerate the typed bindings, verify bytecode and source, and only then consider enabling frontend writes. The [operator runbook](../docs/operator-runbook.md) covers the separate stock-policy, mirror, and monitoring procedures.
