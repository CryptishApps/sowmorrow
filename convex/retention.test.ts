import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it } from "vitest";
import crons from "./crons";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const pruneTerminalRecords = makeFunctionReference<"mutation">("retention:pruneTerminalRecords");

const VAULT_LOWER = "0x1000000000000000000000000000000000000001";
const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

type DeliveryStatus = "pending" | "processing" | "applied" | "duplicate" | "failed";

async function seedDelivery(
  t: ReturnType<typeof convexTest>,
  deliveryId: string,
  processingStatus: DeliveryStatus,
  receivedAt: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("webhookDeliveries", {
      provider: "cdp",
      deliveryId,
      bodyHash: `0x${deliveryId.length.toString(16).padStart(64, "0")}`,
      receivedAt,
      chainId: 8453,
      vaultAddressLower: VAULT_LOWER,
      transactionHashLower: `0x${"b".repeat(64)}`,
      logIndex: 0,
      blockNumber: 100,
      eventName: "GiftCreated",
      processingStatus,
      attempts: 1,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });
  });
}

async function seedRun(t: ReturnType<typeof convexTest>, endedAt: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert("syncRuns", {
      pipeline: "vault-events",
      chainId: 8453,
      contractAddressLower: VAULT_LOWER,
      startedAt: endedAt - 1,
      endedAt,
      outcome: "indexed",
    });
  });
}

afterEach(() => {
  delete process.env.SOWMORROW_RETENTION_DAYS;
});

describe("diagnostic retention", () => {
  it("prunes terminal deliveries and old sync runs while keeping live work", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, "old-applied", "applied", NOW - 40 * DAY);
    await seedDelivery(t, "old-duplicate", "duplicate", NOW - 40 * DAY);
    await seedDelivery(t, "old-failed", "failed", NOW - 40 * DAY);
    await seedDelivery(t, "old-pending", "pending", NOW - 40 * DAY);
    await seedDelivery(t, "recent-applied", "applied", NOW - 1 * DAY);
    await seedRun(t, NOW - 40 * DAY);
    await seedRun(t, NOW - 1 * DAY);

    await expect(t.mutation(pruneTerminalRecords, { now: NOW })).resolves.toMatchObject({
      cutoff: NOW - 30 * DAY,
      deliveriesDeleted: 3,
      syncRunsDeleted: 1,
    });

    const deliveries = await t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
    expect(deliveries.map((delivery) => delivery.deliveryId).sort()).toEqual([
      "old-pending",
      "recent-applied",
    ]);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toHaveLength(1);
  });

  it("honours a configured retention window and a bounded batch", async () => {
    process.env.SOWMORROW_RETENTION_DAYS = "1";
    const t = convexTest(schema, modules);
    await seedDelivery(t, "two-days-old", "applied", NOW - 2 * DAY);
    await seedRun(t, NOW - 2 * DAY);

    await expect(t.mutation(pruneTerminalRecords, { now: NOW, limit: 0 })).resolves.toMatchObject({
      cutoff: NOW - DAY,
      deliveriesDeleted: 1,
      syncRunsDeleted: 1,
    });
  });

  it("falls back to the default window for an unusable configured value", async () => {
    process.env.SOWMORROW_RETENTION_DAYS = "not-a-number";
    const t = convexTest(schema, modules);
    await expect(t.mutation(pruneTerminalRecords, { now: NOW })).resolves.toMatchObject({
      cutoff: NOW - 30 * DAY,
    });
  });

  it("uses the wall clock and an explicit window when none are supplied", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(pruneTerminalRecords, { retainSeconds: DAY });
    expect(result.deliveriesDeleted).toBe(0);
    expect(result.cutoff).toBe(Math.floor(Date.now() / 1_000) - DAY);
  });

  it("registers the reconciliation, discovery, monitor, and retention schedules", () => {
    const scheduled = Object.keys(crons.crons ?? {});
    expect(scheduled.length).toBeGreaterThanOrEqual(5);
  });
});
