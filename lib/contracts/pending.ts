import { getAddress, isAddress, isHash } from "viem";
import type { Address, Hash, Hex } from "viem";
import { z } from "zod";
import { isGiftNoteValid, MAX_GIFT_NOTE_BYTES } from "@/lib/gifts";
import { stocks } from "@/lib/stocks";
import type { StockSymbol } from "@/lib/stocks";

type PendingBase = {
  version: 1;
  chainId: number;
  hash: Hash;
  vault: Address;
  account: Address;
  stock: Address;
  amountRaw: bigint;
  symbol: StockSymbol;
  submittedAt: number;
};

export type PendingApprovalSubmission = PendingBase & {
  kind: "approval";
};

export type PendingGiftSubmission = PendingBase & {
  kind: "gift";
  recipient: Address;
  unlockAt: bigint;
  noteHash: Hex;
  amountInput: string;
  transferableAmount: string;
  note?: string;
  giftId?: bigint;
};

export type PendingPlantSubmission = PendingApprovalSubmission | PendingGiftSubmission;

const address = z
  .string()
  .refine((value) => isAddress(value))
  .transform((value) => getAddress(value));
const hash = z
  .string()
  .refine((value) => isHash(value))
  .transform((value) => value as Hash);
const uint = z.string().transform((value, context) => {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed.toString() !== value) throw new Error("non-canonical uint");
    return parsed;
  } catch {
    context.addIssue({ code: "custom", message: "Expected a canonical unsigned integer" });
    return z.NEVER;
  }
});
const symbols = stocks.map((stock) => stock.symbol) as [StockSymbol, ...StockSymbol[]];
const baseWireShape = {
  version: z.literal(1),
  chainId: z.number().int().nonnegative().safe(),
  hash,
  vault: address,
  account: address,
  stock: address,
  amountRaw: uint,
  symbol: z.enum(symbols),
  submittedAt: z.number().int().nonnegative().safe(),
};
const wireSchema = z.discriminatedUnion("kind", [
  z.object({ ...baseWireShape, kind: z.literal("approval") }).strict(),
  z
    .object({
      ...baseWireShape,
      kind: z.literal("gift"),
      recipient: address,
      unlockAt: uint,
      noteHash: hash.transform((value) => value as Hex),
      amountInput: z.string().min(1).max(256),
      transferableAmount: z.string().min(1).max(256),
      note: z.string().max(MAX_GIFT_NOTE_BYTES).refine(isGiftNoteValid).optional(),
      giftId: uint.optional(),
    })
    .strict(),
]);

export function encodePendingGift(pending: PendingPlantSubmission): string {
  return JSON.stringify({
    ...pending,
    amountRaw: pending.amountRaw.toString(),
    ...(pending.kind === "gift"
      ? { unlockAt: pending.unlockAt.toString(), giftId: pending.giftId?.toString() }
      : {}),
  });
}

export function decodePendingGift(value: string): PendingPlantSubmission | null {
  try {
    const result = wireSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export type PendingClaimSubmission = {
  version: 1;
  chainId: number;
  hash: Hash;
  vault: Address;
  account: Address;
  giftIds: bigint[];
  submittedAt: number;
};

const claimWireSchema = z
  .object({
    version: z.literal(1),
    chainId: z.number().int().nonnegative().safe(),
    hash,
    vault: address,
    account: address,
    giftIds: z.array(uint).min(1).max(64),
    submittedAt: z.number().int().nonnegative().safe(),
  })
  .strict();

export function encodePendingClaim(pending: PendingClaimSubmission): string {
  return JSON.stringify({
    ...pending,
    giftIds: pending.giftIds.map((giftId) => giftId.toString()),
  });
}

export function decodePendingClaim(value: string): PendingClaimSubmission | null {
  try {
    const result = claimWireSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function pendingPlantStorageKey(chainId: number, vault: Address, account: Address) {
  return `sowmorrow.pending-gift.v1:${chainId}:${vault.toLowerCase()}:${account.toLowerCase()}`;
}

export function pendingClaimStorageKey(chainId: number, vault: Address, account: Address) {
  return `sowmorrow.pending-claim.v1:${chainId}:${vault.toLowerCase()}:${account.toLowerCase()}`;
}
