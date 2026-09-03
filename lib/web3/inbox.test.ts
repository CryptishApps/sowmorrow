import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
  chunkedCalls,
  classifyGift,
  compareRows,
  groupByStock,
  knownCounterparties,
  limitSelection,
  LogRangeError,
  partitionSmallGifts,
  readLogRange,
  smallAmountThresholds,
} from "./inbox";
import type { GiftRow, InboxGift, MirrorGift } from "./inbox";

const stockA = getAddress("0x1111111111111111111111111111111111111111");
const stockB = getAddress("0x2222222222222222222222222222222222222222");
const alice = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const mallory = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

function gift(overrides: Partial<InboxGift> = {}): InboxGift {
  return {
    id: 1n,
    sender: alice,
    stock: stockA,
    symbol: "AAPLc",
    amountRaw: 1_000n,
    unlockAt: 1_000n,
    decimals: 6,
    amountScaled: 1_000n,
    chainStatus: "active",
    chainUnlockAt: 1_000n,
    supported: true,
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof classifyGift>[1]> = {}) {
  return {
    blockTimestamp: 2_000n,
    confirmingIds: new Set<string>(),
    mirrorEnabled: false,
    mirrorById: new Map<string, MirrorGift>(),
    ...overrides,
  };
}

function row(overrides: Partial<GiftRow> = {}): GiftRow {
  return classifyGift(gift(overrides), context()) as GiftRow;
}

describe("readLogRange", () => {
  it("returns one page when the range is readable and small", async () => {
    const reader = vi.fn().mockResolvedValue([1, 2, 3]);
    await expect(readLogRange(reader, 0n, 1_999n, 200)).resolves.toEqual({
      logs: [1, 2, 3],
      nextToBlock: null,
    });
    expect(reader).toHaveBeenCalledWith(0n, 1_999n);
  });

  it("bisects and stops early when the newest half already fills the cap", async () => {
    const reader = vi.fn(async (from: bigint, to: bigint) => {
      if (from === 0n && to === 999n) return Array.from({ length: 6 }, (_, index) => index);
      if (from === 500n && to === 999n) return Array.from({ length: 4 }, (_, index) => index);
      return [];
    });

    await expect(readLogRange(reader, 0n, 999n, 4)).resolves.toEqual({
      logs: [0, 1, 2, 3],
      nextToBlock: 499n,
    });
  });

  it("bisects when the provider rejects the range instead of parsing its message", async () => {
    const reader = vi.fn(async (from: bigint, to: bigint) => {
      if (to - from > 100n) throw new Error("query returned more than 10000 results");
      return [`${from}-${to}`];
    });

    const page = await readLogRange(reader, 0n, 399n, 200);
    expect(page.nextToBlock).toBeNull();
    expect(page.logs).toEqual(["300-399", "200-299", "100-199", "0-99"]);
  });

  it("reports a typed error when a single block cannot be read", async () => {
    const reader = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(readLogRange(reader, 7n, 7n, 200)).rejects.toBeInstanceOf(LogRangeError);
  });

  it("reports a typed error when one block exceeds the cap", async () => {
    const reader = vi.fn().mockResolvedValue([1, 2, 3]);
    await expect(readLogRange(reader, 7n, 7n, 2)).rejects.toMatchObject({ code: "too_many_logs" });
  });

  it("does nothing for an inverted range", async () => {
    const reader = vi.fn();
    await expect(readLogRange(reader, 9n, 8n, 200)).resolves.toEqual({ logs: [], nextToBlock: null });
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("chunkedCalls", () => {
  it("splits every batch at the configured chunk size", async () => {
    const sizes: number[] = [];
    const run = vi.fn(async (calls: readonly number[]) => {
      sizes.push(calls.length);
      return calls.map((call) => call * 2);
    });

    const results = await chunkedCalls(
      run,
      Array.from({ length: 250 }, (_, index) => index),
      100,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
    expect(results[249]).toBe(498);
  });
});

describe("classifyGift", () => {
  it("marks an unlocked, supported, active gift ready and selectable", () => {
    const classified = classifyGift(gift(), context());
    expect(classified).toMatchObject({ state: "ready", selectable: true, reason: null });
  });

  it("keeps a retired stock claimable", () => {
    expect(classifyGift(gift({ supported: false }), context())).toMatchObject({
      state: "retired",
      selectable: true,
    });
  });

  it("locks a gift against the observed block timestamp, not the wall clock", () => {
    expect(classifyGift(gift({ chainUnlockAt: 9_000n }), context())).toMatchObject({
      state: "locked",
      selectable: false,
      reason: "locked",
    });
  });

  it("shows a claim submitted from this browser as confirming", () => {
    const classified = classifyGift(gift(), context({ confirmingIds: new Set(["1"]) }));
    expect(classified).toMatchObject({ state: "confirming", selectable: false, reason: "confirming" });
  });

  it("shows syncing when the mirror still reports an already claimed gift as active", () => {
    const classified = classifyGift(
      gift({ chainStatus: "claimed" }),
      context({
        mirrorEnabled: true,
        mirrorById: new Map([
          ["1", { giftId: 1n, status: "active", amountRaw: 1_000n, recipientLower: "0x" }],
        ]),
      }),
    );
    expect(classified).toMatchObject({ state: "syncing", mirror: "behind", mirrorStatus: "active" });
  });

  it("shows needs-attention when the mirror claims a gift the chain still reports active", () => {
    const classified = classifyGift(
      gift(),
      context({
        mirrorEnabled: true,
        mirrorById: new Map([
          ["1", { giftId: 1n, status: "claimed", amountRaw: 1_000n, recipientLower: "0x" }],
        ]),
      }),
    );
    expect(classified).toMatchObject({
      state: "needs-attention",
      mirror: "conflict",
      selectable: false,
      reason: "conflict",
    });
  });

  it("treats a differing mirror amount as a conflict", () => {
    const classified = classifyGift(
      gift(),
      context({
        mirrorEnabled: true,
        mirrorById: new Map([["1", { giftId: 1n, status: "active", amountRaw: 999n, recipientLower: "0x" }]]),
      }),
    );
    expect(classified.state).toBe("needs-attention");
  });

  it("falls back to the event fields when the vault read fails", () => {
    const classified = classifyGift(
      gift({ chainStatus: null, chainUnlockAt: null, amountScaled: null, decimals: null }),
      context(),
    );
    expect(classified).toMatchObject({ state: "unreadable", selectable: false, reason: "unreadable" });
    expect(classified.amountRaw).toBe(1_000n);
  });

  it("reports the mirror as off when no mirror is configured", () => {
    expect(classifyGift(gift(), context()).mirror).toBe("off");
  });
});

describe("ordering, grouping, and dust resistance", () => {
  it("sorts by scaled amount descending and puts unreadable rows last", () => {
    const rows = [
      row({ id: 1n, amountScaled: 5n }),
      row({ id: 2n, amountScaled: null, chainStatus: null }),
      row({ id: 3n, amountScaled: 90n }),
    ].sort(compareRows);
    expect(rows.map((entry) => entry.id)).toEqual([3n, 1n, 2n]);
  });

  it("derives a per-stock threshold from the largest amount of that stock", () => {
    const thresholds = smallAmountThresholds([
      row({ id: 1n, amountScaled: 5_000_000n }),
      row({ id: 2n, stock: stockB, amountScaled: 2_000n }),
    ]);
    expect(thresholds.get(stockA.toLowerCase())).toBe(5_000n);
    expect(thresholds.get(stockB.toLowerCase())).toBe(2n);
  });

  it("counts already claimed and repeated senders as known counterparties", () => {
    const known = knownCounterparties([
      row({ id: 1n, sender: alice, chainStatus: "claimed" }),
      row({ id: 2n, sender: mallory }),
    ]);
    expect(known.has(alice.toLowerCase())).toBe(true);
    expect(known.has(mallory.toLowerCase())).toBe(false);
  });

  it("collapses dust and unfamiliar senders into the small group", () => {
    const rows = [
      row({ id: 1n, sender: alice, amountScaled: 5_000_000n }),
      row({ id: 2n, sender: alice, amountScaled: 1n }),
      row({ id: 3n, sender: mallory, amountScaled: 4_000_000n }),
    ];
    const partition = partitionSmallGifts(rows, smallAmountThresholds(rows), new Set([alice.toLowerCase()]));
    expect(partition.primary.map((entry) => entry.id)).toEqual([1n]);
    expect(partition.small.map((entry) => entry.id)).toEqual([2n, 3n]);
  });

  it("groups rows by exact stock address with the selectable ids of each group", () => {
    const groups = groupByStock([
      row({ id: 1n, stock: stockA, amountScaled: 10n }),
      row({ id: 2n, stock: stockB, symbol: "TSLAc", chainUnlockAt: 9_000n }),
      row({ id: 3n, stock: stockA, amountScaled: 20n }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows.map((entry) => entry.id)).toEqual([3n, 1n]);
    expect(groups[0].readyIds).toEqual([1n, 3n]);
    expect(groups[1].readyIds).toEqual([]);
  });

  it("never selects an excluded gift and enforces the vault batch cap", () => {
    const rows = Array.from({ length: 25 }, (_, index) => row({ id: BigInt(index + 1) }));
    rows.push(row({ id: 99n, chainUnlockAt: 9_000n }));
    const selected = new Set(rows.map((entry) => entry.id.toString()));

    const limited = limitSelection(selected, rows, 20);
    expect(limited).toHaveLength(20);
    expect(limited.some((entry) => entry.id === 99n)).toBe(false);
  });
});
