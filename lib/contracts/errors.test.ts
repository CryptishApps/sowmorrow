import { describe, expect, it } from "vitest";
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  TransactionExecutionError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { base } from "viem/chains";
import { ChainNotConfiguredError } from "wagmi";
import { GiftFlowError } from "./flows";
import { sowmorrowVaultAbi } from "./generated";
import { mapFlowError, revertedErrorName, TransactionReplacedError } from "./errors";

const transactionHash = `0x${"a".repeat(64)}` as const;

function revert(errorName: string, args: readonly unknown[] = []) {
  const reverted = new ContractFunctionRevertedError({
    abi: sowmorrowVaultAbi,
    data: undefined,
    functionName: "claim",
    message: undefined,
  });
  Object.assign(reverted, { data: { abiItem: undefined, errorName, args } });
  return new ContractFunctionExecutionError(reverted, {
    abi: sowmorrowVaultAbi,
    functionName: "claim",
    args: [1n],
  });
}

describe("mapFlowError", () => {
  it("returns an existing typed flow error unchanged", () => {
    const original = new GiftFlowError("review_changed");
    expect(mapFlowError(original)).toBe(original);
  });

  it("maps a wallet rejection nested inside a viem execution error", () => {
    const wrapped = new TransactionExecutionError(new UserRejectedRequestError(new Error("denied")), {
      account: null,
    });
    expect(mapFlowError(wrapped).code).toBe("user_rejected");
  });

  it("maps a chain mismatch from viem", () => {
    const error = new ChainMismatchError({
      chain: base,
      currentChainId: 84532,
    });
    expect(mapFlowError(error).code).toBe("chain_mismatch");
  });

  it("maps a wagmi unconfigured chain to the same recovery", () => {
    expect(mapFlowError(new ChainNotConfiguredError()).code).toBe("chain_mismatch");
  });

  it.each([
    ["CreationPaused", "creation_paused"],
    ["UnsupportedStock", "stock_unavailable"],
    ["StockNotB20", "stock_unavailable"],
    ["GiftStillLocked", "gift_locked"],
    ["NotGiftRecipient", "not_recipient"],
    ["GiftNotActive", "gift_not_active"],
    ["GiftNotFound", "gift_not_active"],
    ["BatchTooLarge", "batch_too_large"],
    ["EmptyBatch", "empty_claim"],
    ["TokenTransferFailed", "transfer_blocked"],
    ["ERC20InsufficientAllowance", "insufficient_allowance"],
    ["ERC20InsufficientBalance", "insufficient_balance"],
  ] as const)("maps the decoded %s revert to %s", (errorName, code) => {
    expect(mapFlowError(revert(errorName)).code).toBe(code);
  });

  it("exposes the decoded revert name for per-stock retry decisions", () => {
    expect(revertedErrorName(revert("UnsupportedStock"))).toBe("UnsupportedStock");
    expect(revertedErrorName(new Error("plain"))).toBeNull();
  });

  it("maps a replaced transaction through its typed carrier", () => {
    const replaced = new TransactionReplacedError("repriced", transactionHash);
    expect(mapFlowError(replaced).code).toBe("transaction_replaced");
  });

  it("maps missing gas funds separately from missing shares", () => {
    expect(mapFlowError(new InsufficientFundsError({})).code).toBe("insufficient_gas");
  });

  it("maps a receipt wait timeout to a non-destructive pending state", () => {
    const timeout = new WaitForTransactionReceiptTimeoutError({ hash: transactionHash });
    expect(mapFlowError(timeout).code).toBe("receipt_unavailable");
  });

  it("falls back to a neutral unknown failure", () => {
    expect(mapFlowError(new BaseError("something went sideways")).code).toBe("unknown_failure");
    expect(mapFlowError("not an error").code).toBe("unknown_failure");
  });
});
