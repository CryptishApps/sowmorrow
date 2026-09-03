import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { proveGiftClaimed, proveGiftCreated, ReceiptProofError } from "./receipts";
import { sowmorrowVaultAbi } from "./generated";

const vault = getAddress("0x1111111111111111111111111111111111111111");
const sender = getAddress("0x2222222222222222222222222222222222222222");
const recipient = getAddress("0x3333333333333333333333333333333333333333");
const stock = getAddress("0x4444444444444444444444444444444444444444");
const noteHash = `0x${"a".repeat(64)}` as Hex;

type ReceiptLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
};

function createdLog(
  overrides: Partial<{ address: Address; giftId: bigint; recipient: Address; amountRaw: bigint }> = {},
): ReceiptLog {
  const giftId = overrides.giftId ?? 7n;
  const giftRecipient = overrides.recipient ?? recipient;
  return {
    address: overrides.address ?? vault,
    topics: encodeEventTopics({
      abi: sowmorrowVaultAbi,
      eventName: "GiftCreated",
      args: { giftId, sender, recipient: giftRecipient },
    }) as unknown as readonly Hex[],
    data: encodeAbiParameters(
      [
        { name: "stock", type: "address" },
        { name: "amountRaw", type: "uint256" },
        { name: "unlockAt", type: "uint64" },
        { name: "noteHash", type: "bytes32" },
      ],
      [stock, overrides.amountRaw ?? 250_000n, 2_000_000_000n, noteHash],
    ),
  };
}

function claimedLog(
  giftId: bigint,
  amountRaw: bigint,
  overrides: Partial<{ address: Address; recipient: Address }> = {},
): ReceiptLog {
  const giftRecipient = overrides.recipient ?? recipient;
  return {
    address: overrides.address ?? vault,
    topics: encodeEventTopics({
      abi: sowmorrowVaultAbi,
      eventName: "GiftClaimed",
      args: { giftId, recipient: giftRecipient, stock },
    }) as unknown as readonly Hex[],
    data: encodeAbiParameters([{ name: "amountRaw", type: "uint256" }], [amountRaw]),
  };
}

const createdExpectation = {
  vault,
  sender,
  recipient,
  stock,
  amountRaw: 250_000n,
  unlockAt: 2_000_000_000n,
  noteHash,
};

describe("proveGiftCreated", () => {
  it("skips vault logs that do not decode as vault events", () => {
    expect(
      proveGiftCreated(
        {
          status: "success",
          logs: [
            { address: vault, topics: [`0x${"f".repeat(64)}`] as unknown as readonly Hex[], data: "0x" },
            createdLog(),
          ],
        },
        createdExpectation,
      ),
    ).toEqual({ giftId: 7n });
  });

  it("returns the gift ID only for one exact event from the configured vault", () => {
    expect(
      proveGiftCreated(
        {
          status: "success",
          logs: [createdLog(), { ...createdLog({ address: sender }), data: "0x", topics: [] }],
        },
        createdExpectation,
      ),
    ).toEqual({ giftId: 7n });
  });

  it.each([
    ["reverted receipt", { status: "reverted" as const, logs: [createdLog()] }, "receipt_reverted"],
    ["missing event", { status: "success" as const, logs: [] }, "event_missing"],
    [
      "duplicate event",
      { status: "success" as const, logs: [createdLog(), createdLog()] },
      "event_duplicate",
    ],
    ["wrong vault", { status: "success" as const, logs: [createdLog({ address: sender })] }, "event_missing"],
    [
      "mismatched fields",
      { status: "success" as const, logs: [createdLog({ amountRaw: 1n })] },
      "event_mismatch",
    ],
  ])("rejects a %s", (_name, receipt, code) => {
    expect(() => proveGiftCreated(receipt, createdExpectation)).toThrowError(
      expect.objectContaining({ code }) as ReceiptProofError,
    );
  });
});

describe("proveGiftClaimed", () => {
  const expectations = [
    { giftId: 7n, recipient, stock, amountRaw: 250_000n },
    { giftId: 8n, recipient, stock, amountRaw: 500_000n },
  ];

  it("accepts exactly one matching claim event per expected gift", () => {
    expect(
      proveGiftClaimed(
        { status: "success", logs: [claimedLog(8n, 500_000n), claimedLog(7n, 250_000n)] },
        vault,
        expectations,
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "reverted receipt",
      { status: "reverted" as const, logs: [claimedLog(7n, 250_000n), claimedLog(8n, 500_000n)] },
      "receipt_reverted",
    ],
    ["missing event", { status: "success" as const, logs: [claimedLog(7n, 250_000n)] }, "event_missing"],
    [
      "duplicate event",
      { status: "success" as const, logs: [claimedLog(7n, 250_000n), claimedLog(7n, 250_000n)] },
      "event_duplicate",
    ],
    [
      "extra event",
      {
        status: "success" as const,
        logs: [claimedLog(7n, 250_000n), claimedLog(8n, 500_000n), claimedLog(9n, 1n)],
      },
      "event_duplicate",
    ],
    [
      "mismatched fields",
      { status: "success" as const, logs: [claimedLog(7n, 1n), claimedLog(8n, 500_000n)] },
      "event_mismatch",
    ],
  ])("rejects a %s", (_name, receipt, code) => {
    expect(() => proveGiftClaimed(receipt, vault, expectations)).toThrowError(
      expect.objectContaining({ code }) as ReceiptProofError,
    );
  });
});
