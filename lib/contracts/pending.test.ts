import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  decodePendingClaim,
  decodePendingGift,
  encodePendingClaim,
  encodePendingGift,
  pendingClaimStorageKey,
  pendingPlantStorageKey,
} from "./pending";

const pending = {
  version: 1 as const,
  kind: "gift" as const,
  chainId: 8453,
  hash: `0x${"a".repeat(64)}` as const,
  vault: getAddress("0x1111111111111111111111111111111111111111"),
  account: getAddress("0x2222222222222222222222222222222222222222"),
  recipient: getAddress("0x3333333333333333333333333333333333333333"),
  stock: getAddress("0x4444444444444444444444444444444444444444"),
  amountRaw: 12345678901234567890n,
  unlockAt: 2_000_000_000n,
  noteHash: `0x${"b".repeat(64)}` as const,
  amountInput: "0.25",
  transferableAmount: "0.250001",
  symbol: "AAPLc" as const,
  submittedAt: 1_900_000_000,
};
const wire = {
  ...pending,
  amountRaw: pending.amountRaw.toString(),
  unlockAt: pending.unlockAt.toString(),
};

describe("pending gift persistence", () => {
  it("round-trips the exact receipt-proof expectation without losing bigint precision", () => {
    expect(decodePendingGift(encodePendingGift(pending))).toEqual(pending);
  });

  it("round-trips a submitted approval without pretending a gift exists", () => {
    const approval = {
      version: 1 as const,
      kind: "approval" as const,
      chainId: 8453,
      hash: `0x${"c".repeat(64)}` as const,
      vault: pending.vault,
      account: pending.account,
      stock: pending.stock,
      amountRaw: pending.amountRaw,
      symbol: pending.symbol,
      submittedAt: pending.submittedAt,
    };
    expect(decodePendingGift(encodePendingGift(approval))).toEqual(approval);
  });

  it.each([
    "not json",
    JSON.stringify({ ...wire, amountRaw: "01" }),
    JSON.stringify({ ...wire, hash: "0x1234" }),
  ])("rejects malformed persisted data", (value) => {
    expect(decodePendingGift(value)).toBeNull();
  });
});

describe("pending claim persistence", () => {
  it("round-trips a submitted claim batch without losing gift id precision", () => {
    const claim = {
      version: 1 as const,
      chainId: 8453,
      hash: `0x${"d".repeat(64)}` as const,
      vault: pending.vault,
      account: pending.account,
      giftIds: [1n, 115792089237316195423570985008687907853269984665640564039457584007913129639935n],
      submittedAt: pending.submittedAt,
    };
    expect(decodePendingClaim(encodePendingClaim(claim))).toEqual(claim);
  });

  it.each(["", "{}", JSON.stringify({ version: 1, chainId: 8453, giftIds: [] })])(
    "rejects malformed persisted claim data",
    (value) => {
      expect(decodePendingClaim(value)).toBeNull();
    },
  );

  it("scopes persisted keys to chain, vault, and account", () => {
    expect(pendingPlantStorageKey(8453, pending.vault, pending.account)).toBe(
      `sowmorrow.pending-gift.v1:8453:${pending.vault.toLowerCase()}:${pending.account.toLowerCase()}`,
    );
    expect(pendingClaimStorageKey(8453, pending.vault, pending.account)).toBe(
      `sowmorrow.pending-claim.v1:8453:${pending.vault.toLowerCase()}:${pending.account.toLowerCase()}`,
    );
  });
});
