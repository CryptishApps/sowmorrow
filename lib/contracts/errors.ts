import {
  BaseError,
  ChainMismatchError,
  ChainNotFoundError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  SwitchChainError,
  TransactionReceiptNotFoundError,
  UnsupportedChainIdError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import type { Hash } from "viem";
import type { ReplacementReason } from "viem/actions";
import { ChainNotConfiguredError, ConnectorChainMismatchError, ConnectorNotFoundError } from "wagmi";
import { GiftFlowError } from "./flows";
import type { GiftFlowErrorCode } from "./flows";

export class TransactionReplacedError extends Error {
  constructor(
    public readonly reason: ReplacementReason,
    public readonly replacementHash: Hash,
  ) {
    super("The wallet replaced the submitted transaction.");
    this.name = "TransactionReplacedError";
  }
}

const contractErrorCodes: Record<string, GiftFlowErrorCode> = {
  BatchTooLarge: "batch_too_large",
  CreationPaused: "creation_paused",
  EmptyBatch: "empty_claim",
  GiftAmountBelowMinimum: "amount_below_minimum",
  GiftNotActive: "gift_not_active",
  GiftNotFound: "gift_not_active",
  GiftStillLocked: "gift_locked",
  InvalidRecipient: "invalid_recipient",
  NotGiftRecipient: "not_recipient",
  StockAssetInterfaceInvalid: "stock_unavailable",
  StockMultiplierInvalid: "stock_unavailable",
  StockNotAsset: "stock_unavailable",
  StockNotB20: "stock_unavailable",
  StockNotInitialized: "stock_unavailable",
  StockPrecisionInvalid: "stock_unavailable",
  TokenTransferFailed: "transfer_blocked",
  UnexpectedTokenBalanceDelta: "transfer_blocked",
  UnlockNotInFuture: "unlock_too_soon",
  UnsupportedStock: "stock_unavailable",
  ZeroAmount: "invalid_amount",
  ERC20InsufficientAllowance: "insufficient_allowance",
  ERC20InsufficientBalance: "insufficient_balance",
  ERC20InvalidReceiver: "invalid_recipient",
  ERC20InvalidSpender: "invalid_recipient",
};

function walk(error: unknown, predicate: (candidate: unknown) => boolean): unknown {
  if (error instanceof BaseError) return error.walk(predicate);
  return predicate(error) ? error : null;
}

export function revertedErrorName(error: unknown): string | null {
  const reverted = walk(error, (candidate) => candidate instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return reverted.data?.errorName ?? null;
}

export function mapFlowError(error: unknown): GiftFlowError {
  if (error instanceof GiftFlowError) return error;
  if (error instanceof TransactionReplacedError) return new GiftFlowError("transaction_replaced");

  if (walk(error, (candidate) => candidate instanceof UserRejectedRequestError) !== null) {
    return new GiftFlowError("user_rejected");
  }

  const chainMismatch = walk(
    error,
    (candidate) =>
      candidate instanceof ChainMismatchError ||
      candidate instanceof ChainNotFoundError ||
      candidate instanceof UnsupportedChainIdError ||
      candidate instanceof SwitchChainError ||
      candidate instanceof ChainNotConfiguredError ||
      candidate instanceof ConnectorChainMismatchError,
  );
  if (chainMismatch !== null) return new GiftFlowError("chain_mismatch");

  const errorName = revertedErrorName(error);
  const mapped = errorName === null ? undefined : contractErrorCodes[errorName];
  if (mapped !== undefined) return new GiftFlowError(mapped);

  if (walk(error, (candidate) => candidate instanceof InsufficientFundsError) !== null) {
    return new GiftFlowError("insufficient_gas");
  }

  const receiptPending = walk(
    error,
    (candidate) =>
      candidate instanceof WaitForTransactionReceiptTimeoutError ||
      candidate instanceof TransactionReceiptNotFoundError,
  );
  if (receiptPending !== null) return new GiftFlowError("receipt_unavailable");

  if (walk(error, (candidate) => candidate instanceof ConnectorNotFoundError) !== null) {
    return new GiftFlowError("wallet_unavailable");
  }

  return new GiftFlowError("unknown_failure");
}
