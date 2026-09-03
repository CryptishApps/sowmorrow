import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const applyCanonicalVaultLog = makeFunctionReference<"mutation">("events:applyCanonicalVaultLog");
const setEventCanonicality = makeFunctionReference<"mutation">("events:setEventCanonicality");
const listEventsAboveBlock = makeFunctionReference<"query">("events:listEventsAboveBlock");

const vault = "0x1000000000000000000000000000000000000001";
const recipient = "0x2000000000000000000000000000000000000002";
const sender = "0x3000000000000000000000000000000000000003";
const stock = "0xb200000000000000000000c2e324d24d7eecd1fb";
const zeroHash = `0x${"0".repeat(64)}`;

function created(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    vaultAddressLower: vault,
    transactionHashLower: `0x${"1".repeat(64)}`,
    transactionIndex: 1,
    logIndex: 4,
    blockNumber: 100,
    blockHashLower: `0x${"2".repeat(64)}`,
    eventName: "GiftCreated",
    giftIdDecimal: "1",
    senderLower: sender,
    recipientLower: recipient,
    stockLower: stock,
    amountRawDecimal: "100",
    unlockAt: 1_900_000_000,
    noteHashLower: zeroHash,
    canonicality: "safe",
    source: "reconciler",
    observedAt: 1_800_000_000,
    ...overrides,
  };
}

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    vaultAddressLower: vault,
    transactionHashLower: `0x${"3".repeat(64)}`,
    transactionIndex: 2,
    logIndex: 8,
    blockNumber: 200,
    blockHashLower: `0x${"4".repeat(64)}`,
    eventName: "GiftClaimed",
    giftIdDecimal: "1",
    recipientLower: recipient,
    stockLower: stock,
    amountRawDecimal: "100",
    canonicality: "safe",
    source: "webhook",
    observedAt: 1_800_000_100,
    ...overrides,
  };
}

describe("canonical vault event writer", () => {
  it("builds one gift projection and merges duplicate observations", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(applyCanonicalVaultLog, created())).resolves.toMatchObject({
      operation: "inserted",
    });
    await expect(
      t.mutation(applyCanonicalVaultLog, created({ source: "webhook", canonicality: "tip" })),
    ).resolves.toMatchObject({ operation: "duplicate" });
    await expect(t.mutation(applyCanonicalVaultLog, claimed())).resolves.toMatchObject({
      operation: "inserted",
    });

    const gifts = await t.run((ctx) => ctx.db.query("gifts").collect());
    const events = await t.run((ctx) => ctx.db.query("chainEvents").collect());
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({ state: "claimed", giftIdDecimal: "1", projectionVersion: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ seenViaWebhook: true, seenViaReconciler: true, canonicality: "safe" });
  });

  it("quarantines a claim observed before its create event", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(applyCanonicalVaultLog, claimed())).resolves.toEqual({
      operation: "quarantined_claim_before_create",
    });
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(0);
  });

  it("rejects a conflicting body for the same transaction and log", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await expect(t.mutation(applyCanonicalVaultLog, created({ amountRawDecimal: "101" }))).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toHaveLength(1);
  });

  it("keeps identical gift ids isolated by vault", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await t.mutation(
      applyCanonicalVaultLog,
      created({
        vaultAddressLower: "0x1000000000000000000000000000000000000002",
        transactionHashLower: `0x${"5".repeat(64)}`,
      }),
    );
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(2);
  });

  it("removes an orphaned create from the recipient projection", async () => {
    const t = convexTest(schema, modules);
    const event = created({ canonicality: "tip" });
    await t.mutation(applyCanonicalVaultLog, event);
    await expect(
      t.mutation(setEventCanonicality, {
        chainId: event.chainId,
        vaultAddressLower: event.vaultAddressLower,
        transactionHashLower: event.transactionHashLower,
        logIndex: event.logIndex,
        blockHashLower: event.blockHashLower,
        canonicality: "orphaned",
        observedAt: 1_800_000_200,
      }),
    ).resolves.toEqual({ operation: "updated" });
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(0);
  });

  it("restores an active gift when its claim is orphaned", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    const claim = claimed({ canonicality: "tip" });
    await t.mutation(applyCanonicalVaultLog, claim);
    await t.mutation(setEventCanonicality, {
      chainId: claim.chainId,
      vaultAddressLower: claim.vaultAddressLower,
      transactionHashLower: claim.transactionHashLower,
      logIndex: claim.logIndex,
      blockHashLower: claim.blockHashLower,
      canonicality: "orphaned",
      observedAt: 1_800_000_200,
    });
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toMatchObject([
      { state: "active", projectionVersion: 1 },
    ]);
  });

  it("stores a reinclusion separately from an orphaned transaction log", async () => {
    const t = convexTest(schema, modules);
    const first = created({ canonicality: "tip" });
    await t.mutation(applyCanonicalVaultLog, first);
    await t.mutation(setEventCanonicality, {
      chainId: first.chainId,
      vaultAddressLower: first.vaultAddressLower,
      transactionHashLower: first.transactionHashLower,
      logIndex: first.logIndex,
      blockHashLower: first.blockHashLower,
      canonicality: "orphaned",
      observedAt: 1_800_000_200,
    });
    await t.mutation(
      applyCanonicalVaultLog,
      created({
        canonicality: "safe",
        blockNumber: 101,
        blockHashLower: `0x${"9".repeat(64)}`,
        observedAt: 1_800_000_300,
      }),
    );

    const events = await t.run((ctx) => ctx.db.query("chainEvents").collect());
    const gifts = await t.run((ctx) => ctx.db.query("gifts").collect());
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.canonicality).sort()).toEqual(["orphaned", "safe"]);
    expect(gifts[0]).toMatchObject({ createdBlock: 101, createdCanonicality: "safe" });
  });
  it("lists only non-orphaned events above a block for reorg rollback", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created({ blockNumber: 90 }));
    const orphan = created({
      giftIdDecimal: "2",
      transactionHashLower: `0x${"6".repeat(64)}`,
      blockNumber: 300,
      blockHashLower: `0x${"7".repeat(64)}`,
    });
    await t.mutation(applyCanonicalVaultLog, orphan);
    await t.mutation(
      applyCanonicalVaultLog,
      created({
        giftIdDecimal: "3",
        transactionHashLower: `0x${"8".repeat(64)}`,
        blockNumber: 400,
        blockHashLower: `0x${"a".repeat(64)}`,
      }),
    );
    await t.mutation(setEventCanonicality, {
      chainId: orphan.chainId,
      vaultAddressLower: orphan.vaultAddressLower,
      transactionHashLower: orphan.transactionHashLower,
      logIndex: orphan.logIndex,
      blockHashLower: orphan.blockHashLower,
      canonicality: "orphaned",
      observedAt: 1_800_000_400,
    });

    const above = await t.query(listEventsAboveBlock, {
      chainId: 8453,
      vaultAddressLower: vault,
      aboveBlock: 100,
      limit: 10,
    });
    expect(above.map((event: { giftIdDecimal: string }) => event.giftIdDecimal)).toEqual(["3"]);

    const clamped = await t.query(listEventsAboveBlock, {
      chainId: 8453,
      vaultAddressLower: vault,
      aboveBlock: 0,
      limit: 0,
    });
    expect(clamped).toHaveLength(1);
  });

  it("leaves an already orphaned event unchanged and reports a missing inclusion", async () => {
    const t = convexTest(schema, modules);
    const event = created();
    await t.mutation(applyCanonicalVaultLog, event);
    await expect(
      t.mutation(setEventCanonicality, {
        chainId: event.chainId,
        vaultAddressLower: event.vaultAddressLower,
        transactionHashLower: event.transactionHashLower,
        logIndex: event.logIndex,
        blockHashLower: event.blockHashLower,
        canonicality: "safe",
        observedAt: 1_800_000_400,
      }),
    ).resolves.toEqual({ operation: "unchanged" });
    await expect(
      t.mutation(setEventCanonicality, {
        chainId: event.chainId,
        vaultAddressLower: event.vaultAddressLower,
        transactionHashLower: `0x${"c".repeat(64)}`,
        logIndex: event.logIndex,
        blockHashLower: event.blockHashLower,
        canonicality: "orphaned",
        observedAt: 1_800_000_400,
      }),
    ).resolves.toEqual({ operation: "missing" });
  });

  it("rejects malformed wire values, shapes, and unsafe numbers", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(applyCanonicalVaultLog, created({ blockNumber: -1 }))).rejects.toThrow();
    await expect(
      t.mutation(applyCanonicalVaultLog, created({ recipientLower: recipient.toUpperCase() })),
    ).rejects.toThrow();
    await expect(t.mutation(applyCanonicalVaultLog, created({ giftIdDecimal: "007" }))).rejects.toThrow();
    await expect(t.mutation(applyCanonicalVaultLog, created({ senderLower: undefined }))).rejects.toThrow();
    await expect(t.mutation(applyCanonicalVaultLog, claimed({ unlockAt: 1_900_000_000 }))).rejects.toThrow();
  });

  it("rejects a second create for the same gift id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await expect(
      t.mutation(
        applyCanonicalVaultLog,
        created({ transactionHashLower: `0x${"d".repeat(64)}`, blockNumber: 105 }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a claim whose payload disagrees with the create", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await expect(t.mutation(applyCanonicalVaultLog, claimed({ amountRawDecimal: "99" }))).rejects.toThrow();
  });
  it("rejects a gift id that is not a decimal integer at all", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(applyCanonicalVaultLog, created({ giftIdDecimal: "abc" }))).rejects.toThrow();
  });

  it("orphans the earlier inclusion when the same log reappears in another block", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created({ canonicality: "tip" }));
    await t.mutation(
      applyCanonicalVaultLog,
      created({ blockNumber: 101, blockHashLower: `0x${"b".repeat(64)}`, observedAt: 1_800_000_500 }),
    );

    const events = await t.run((ctx) => ctx.db.query("chainEvents").collect());
    expect(events.map((event) => event.canonicality).sort()).toEqual(["orphaned", "safe"]);
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toMatchObject([{ createdBlock: 101 }]);
  });

  it("rejects a rebuild from a stored create that lost its required fields", async () => {
    const t = convexTest(schema, modules);
    const event = created({ canonicality: "tip" });
    await t.mutation(applyCanonicalVaultLog, event);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("chainEvents").unique();
      await ctx.db.patch(stored!._id, { senderLower: undefined });
    });

    await expect(
      t.mutation(setEventCanonicality, {
        chainId: event.chainId,
        vaultAddressLower: event.vaultAddressLower,
        transactionHashLower: event.transactionHashLower,
        logIndex: event.logIndex,
        blockHashLower: event.blockHashLower,
        canonicality: "safe",
        observedAt: 1_800_000_600,
      }),
    ).rejects.toThrow();
  });
});
