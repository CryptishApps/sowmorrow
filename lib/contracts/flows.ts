import { formatUnits, zeroAddress } from "viem";
import type { Address, Hash, Hex } from "viem";
import { parseGiftAmount, UNLOCK_SAFETY_MARGIN_SECONDS } from "@/lib/gifts";
import type { GiftClaimedExpectation, GiftCreatedExpectation } from "./receipts";

export type PlantPhase =
  | "resolving_recipient"
  | "quoting_amount"
  | "revalidating_review"
  | "awaiting_approval"
  | "confirming_approval"
  | "awaiting_plant"
  | "confirming_plant"
  | "success";

export type ClaimPhase = "awaiting_claim" | "confirming_claim" | "success";
export type GiftFlowErrorCode =
  | "recipient_unresolved"
  | "invalid_recipient"
  | "invalid_amount"
  | "amount_below_minimum"
  | "insufficient_balance"
  | "stock_unavailable"
  | "creation_paused"
  | "approval_not_confirmed"
  | "unlock_too_soon"
  | "review_changed"
  | "empty_claim"
  | "user_rejected"
  | "chain_mismatch"
  | "insufficient_allowance"
  | "insufficient_gas"
  | "transaction_replaced"
  | "transfer_blocked"
  | "gift_locked"
  | "gift_not_active"
  | "not_recipient"
  | "batch_too_large"
  | "receipt_unavailable"
  | "wallet_unavailable"
  | "unknown_failure";

const errorMessages: Record<GiftFlowErrorCode, string> = {
  recipient_unresolved: "That name does not resolve to an address on Base.",
  invalid_recipient: "Choose a valid recipient address.",
  invalid_amount: "Enter a positive amount supported by this stock.",
  amount_below_minimum: "Enter at least this stock's minimum gift amount.",
  insufficient_balance: "Your wallet does not hold enough of this stock.",
  stock_unavailable: "This stock is not currently open for new gifts.",
  creation_paused: "New gifts are temporarily paused. Existing claims stay available.",
  approval_not_confirmed: "The approval did not settle with the required amount.",
  unlock_too_soon: "Choose an opening time at least five minutes after the latest Base block.",
  review_changed: "The resolved recipient or onchain terms changed. Review the gift again before signing.",
  empty_claim: "There are no ready gifts to claim.",
  user_rejected: "The request was cancelled in your wallet. Nothing new was submitted.",
  chain_mismatch: "Your wallet is on a different network than this gift.",
  insufficient_allowance: "The approved amount is lower than this gift needs.",
  insufficient_gas: "This wallet does not hold enough ETH on Base to pay for the transaction.",
  transaction_replaced:
    "Your wallet replaced the submitted transaction. Check the replacement before retrying.",
  transfer_blocked: "The token issuer currently prevents this transfer.",
  gift_locked: "This gift is still locked at the current Base block time.",
  gift_not_active: "This gift was already claimed or is no longer active.",
  not_recipient: "The connected wallet is not the recipient of this gift.",
  batch_too_large: "Select fewer gifts; the vault claims a limited batch at a time.",
  receipt_unavailable: "The transaction was submitted, but its receipt is not available yet.",
  wallet_unavailable: "No compatible browser wallet was found.",
  unknown_failure: "The request did not finish. Check your wallet activity before trying again.",
};

export class GiftFlowError extends Error {
  constructor(
    public readonly code: GiftFlowErrorCode,
    message: string = errorMessages[code],
  ) {
    super(message);
    this.name = "GiftFlowError";
  }
}

export type PlantGateway = {
  resolveRecipient: (input: string) => Promise<Address | null>;
  getBlockSnapshot: () => Promise<{ number: bigint; timestamp: bigint }>;
  getVaultVersion: (vault: Address, blockNumber?: bigint) => Promise<string>;
  getDecimals: (stock: Address, blockNumber?: bigint) => Promise<number>;
  toRawBalance: (stock: Address, amountScaled: bigint, blockNumber?: bigint) => Promise<bigint>;
  toScaledBalance: (stock: Address, amountRaw: bigint, blockNumber?: bigint) => Promise<bigint>;
  getRawBalance: (stock: Address, account: Address, blockNumber?: bigint) => Promise<bigint>;
  getAllowance: (stock: Address, account: Address, vault: Address, blockNumber?: bigint) => Promise<bigint>;
  isStockSupported: (stock: Address, vault: Address, blockNumber?: bigint) => Promise<boolean>;
  getMinGiftAmountRaw: (stock: Address, vault: Address, blockNumber?: bigint) => Promise<bigint>;
  isCreationPaused: (vault: Address, blockNumber?: bigint) => Promise<boolean>;
  hasContractCode: (address: Address, blockNumber?: bigint) => Promise<boolean>;
  approve: (stock: Address, vault: Address, amountRaw: bigint) => Promise<Hash>;
  createGift: (
    stock: Address,
    recipient: Address,
    amountRaw: bigint,
    unlockAt: bigint,
    noteHash: Hex,
  ) => Promise<Hash>;
  waitForApprovalReceipt: (hash: Hash) => Promise<void>;
  waitForGiftReceipt: (hash: Hash, expected: GiftCreatedExpectation) => Promise<{ giftId: bigint }>;
};

export type PlantInput = {
  account: Address;
  stock: Address;
  vault: Address;
  recipientInput: string;
  amountInput: string;
  unlockAt: bigint;
  noteHash: Hex;
};

export type PlantResult = {
  recipient: Address;
  amountRaw: bigint;
  approvalHash: Hash | null;
  giftHash: Hash;
  giftId: bigint;
};

export type PreparedPlantIntent = PlantInput & {
  recipient: Address;
  decimals: number;
  amountScaled: bigint;
  amountRaw: bigint;
  minAmountRaw: bigint;
  transferableAmountScaled: bigint;
  approvalRequired: boolean;
  recipientIsContract: boolean;
  observedBlockNumber: bigint;
  observedBlockTimestamp: bigint;
  vaultVersion: string;
};

export type SubmittedPlantTransaction = {
  kind: "approval" | "gift";
  hash: Hash;
};

export { UNLOCK_SAFETY_MARGIN_SECONDS } from "@/lib/gifts";

export async function preparePlant(
  gateway: PlantGateway,
  input: PlantInput,
  onPhase: (phase: PlantPhase) => void = () => undefined,
): Promise<PreparedPlantIntent> {
  onPhase("resolving_recipient");
  const [recipient, block] = await Promise.all([
    gateway.resolveRecipient(input.recipientInput),
    gateway.getBlockSnapshot(),
  ]);
  if (recipient === null) throw new GiftFlowError("recipient_unresolved");
  if (recipient === zeroAddress || recipient === input.vault) throw new GiftFlowError("invalid_recipient");
  if (input.unlockAt <= block.timestamp + UNLOCK_SAFETY_MARGIN_SECONDS) {
    throw new GiftFlowError("unlock_too_soon");
  }

  onPhase("quoting_amount");
  const decimals = await gateway.getDecimals(input.stock, block.number);
  const amountScaled = parseGiftAmount(input.amountInput, decimals);
  if (amountScaled === null) throw new GiftFlowError("invalid_amount");

  const rawFloor = await gateway.toRawBalance(input.stock, amountScaled, block.number);
  const scaledFromFloor = await gateway.toScaledBalance(input.stock, rawFloor, block.number);
  const amountRaw = scaledFromFloor < amountScaled ? rawFloor + 1n : rawFloor;
  if (amountRaw === 0n) throw new GiftFlowError("invalid_amount");
  const transferableAmountScaled =
    amountRaw === rawFloor
      ? scaledFromFloor
      : await gateway.toScaledBalance(input.stock, amountRaw, block.number);

  const [
    balance,
    allowance,
    stockSupported,
    minAmountRaw,
    creationPaused,
    vaultVersion,
    recipientIsContract,
  ] = await Promise.all([
    gateway.getRawBalance(input.stock, input.account, block.number),
    gateway.getAllowance(input.stock, input.account, input.vault, block.number),
    gateway.isStockSupported(input.stock, input.vault, block.number),
    gateway.getMinGiftAmountRaw(input.stock, input.vault, block.number),
    gateway.isCreationPaused(input.vault, block.number),
    gateway.getVaultVersion(input.vault, block.number),
    gateway.hasContractCode(recipient, block.number),
  ]);
  if (creationPaused) throw new GiftFlowError("creation_paused");
  if (!stockSupported) throw new GiftFlowError("stock_unavailable");
  if (amountRaw < minAmountRaw) {
    const minAmountScaled = await gateway.toScaledBalance(input.stock, minAmountRaw, block.number);
    throw new GiftFlowError(
      "amount_below_minimum",
      `The minimum gift for this stock is ${formatUnits(minAmountScaled, decimals)} shares.`,
    );
  }
  if (balance < amountRaw) throw new GiftFlowError("insufficient_balance");

  return {
    ...input,
    recipient,
    decimals,
    amountScaled,
    amountRaw,
    minAmountRaw,
    transferableAmountScaled,
    approvalRequired: allowance < amountRaw,
    recipientIsContract,
    observedBlockNumber: block.number,
    observedBlockTimestamp: block.timestamp,
    vaultVersion,
  };
}

export async function executePreparedPlant(
  gateway: PlantGateway,
  intent: PreparedPlantIntent,
  onPhase: (phase: PlantPhase) => void = () => undefined,
  onSubmitted: (transaction: SubmittedPlantTransaction) => void = () => undefined,
): Promise<PlantResult> {
  onPhase("revalidating_review");
  const [
    recipient,
    block,
    vaultVersion,
    decimals,
    transferableAmountScaled,
    balance,
    allowance,
    stockSupported,
    minAmountRaw,
    creationPaused,
    recipientIsContract,
  ] = await Promise.all([
    gateway.resolveRecipient(intent.recipientInput),
    gateway.getBlockSnapshot(),
    gateway.getVaultVersion(intent.vault),
    gateway.getDecimals(intent.stock),
    gateway.toScaledBalance(intent.stock, intent.amountRaw),
    gateway.getRawBalance(intent.stock, intent.account),
    gateway.getAllowance(intent.stock, intent.account, intent.vault),
    gateway.isStockSupported(intent.stock, intent.vault),
    gateway.getMinGiftAmountRaw(intent.stock, intent.vault),
    gateway.isCreationPaused(intent.vault),
    gateway.hasContractCode(intent.recipient),
  ]);
  if (intent.unlockAt <= block.timestamp + UNLOCK_SAFETY_MARGIN_SECONDS) {
    throw new GiftFlowError("unlock_too_soon");
  }
  if (
    recipient === null ||
    recipient.toLowerCase() !== intent.recipient.toLowerCase() ||
    vaultVersion !== intent.vaultVersion ||
    decimals !== intent.decimals ||
    transferableAmountScaled !== intent.transferableAmountScaled ||
    recipientIsContract !== intent.recipientIsContract ||
    intent.amountRaw < minAmountRaw
  ) {
    throw new GiftFlowError("review_changed");
  }
  if (creationPaused) throw new GiftFlowError("creation_paused");
  if (!stockSupported) throw new GiftFlowError("stock_unavailable");
  if (balance < intent.amountRaw) throw new GiftFlowError("insufficient_balance");

  let approvalHash: Hash | null = null;
  if (allowance < intent.amountRaw) {
    onPhase("awaiting_approval");
    approvalHash = await gateway.approve(intent.stock, intent.vault, intent.amountRaw);
    onSubmitted({ kind: "approval", hash: approvalHash });
    onPhase("confirming_approval");
    await gateway.waitForApprovalReceipt(approvalHash);
    const confirmedAllowance = await gateway.getAllowance(intent.stock, intent.account, intent.vault);
    if (confirmedAllowance < intent.amountRaw) throw new GiftFlowError("approval_not_confirmed");
  }

  const [finalRecipient, finalBlock] = await Promise.all([
    gateway.resolveRecipient(intent.recipientInput),
    gateway.getBlockSnapshot(),
  ]);
  if (finalRecipient === null || finalRecipient.toLowerCase() !== intent.recipient.toLowerCase()) {
    throw new GiftFlowError("review_changed");
  }
  if (intent.unlockAt <= finalBlock.timestamp + UNLOCK_SAFETY_MARGIN_SECONDS) {
    throw new GiftFlowError("unlock_too_soon");
  }

  const [finalScaled, finalCode, finalSupported, finalPaused, finalBalance, finalMinimum] = await Promise.all(
    [
      gateway.toScaledBalance(intent.stock, intent.amountRaw, finalBlock.number),
      gateway.hasContractCode(intent.recipient, finalBlock.number),
      gateway.isStockSupported(intent.stock, intent.vault, finalBlock.number),
      gateway.isCreationPaused(intent.vault, finalBlock.number),
      gateway.getRawBalance(intent.stock, intent.account, finalBlock.number),
      gateway.getMinGiftAmountRaw(intent.stock, intent.vault, finalBlock.number),
    ],
  );
  if (
    finalScaled !== intent.transferableAmountScaled ||
    finalCode !== intent.recipientIsContract ||
    intent.amountRaw < finalMinimum
  ) {
    throw new GiftFlowError("review_changed");
  }
  if (!finalSupported) throw new GiftFlowError("stock_unavailable");
  if (finalPaused) throw new GiftFlowError("creation_paused");
  if (finalBalance < intent.amountRaw) throw new GiftFlowError("insufficient_balance");

  onPhase("awaiting_plant");
  const giftHash = await gateway.createGift(
    intent.stock,
    intent.recipient,
    intent.amountRaw,
    intent.unlockAt,
    intent.noteHash,
  );
  onSubmitted({ kind: "gift", hash: giftHash });
  onPhase("confirming_plant");
  const proof = await gateway.waitForGiftReceipt(giftHash, {
    vault: intent.vault,
    sender: intent.account,
    recipient: intent.recipient,
    stock: intent.stock,
    amountRaw: intent.amountRaw,
    unlockAt: intent.unlockAt,
    noteHash: intent.noteHash,
  });
  onPhase("success");
  return {
    recipient: intent.recipient,
    amountRaw: intent.amountRaw,
    approvalHash,
    giftHash,
    giftId: proof.giftId,
  };
}

export async function executePlant(
  gateway: PlantGateway,
  input: PlantInput,
  onPhase: (phase: PlantPhase) => void = () => undefined,
): Promise<PlantResult> {
  const intent = await preparePlant(gateway, input, onPhase);
  return executePreparedPlant(gateway, intent, onPhase);
}

export type ClaimGateway = {
  claim: (giftId: bigint) => Promise<Hash>;
  claimMany: (giftIds: readonly bigint[]) => Promise<Hash>;
  waitForClaimReceipt: (hash: Hash, expected: readonly GiftClaimedExpectation[]) => Promise<void>;
};

export async function executeClaim(
  gateway: ClaimGateway,
  gifts: readonly GiftClaimedExpectation[],
  onPhase: (phase: ClaimPhase) => void = () => undefined,
): Promise<Hash> {
  if (gifts.length === 0) throw new GiftFlowError("empty_claim");
  const giftIds = gifts.map((gift) => gift.giftId);
  onPhase("awaiting_claim");
  const hash = giftIds.length === 1 ? await gateway.claim(giftIds[0]) : await gateway.claimMany(giftIds);
  onPhase("confirming_claim");
  await gateway.waitForClaimReceipt(hash, gifts);
  onPhase("success");
  return hash;
}
