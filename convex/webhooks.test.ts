import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const recordVerifiedDelivery = makeFunctionReference<"mutation">("webhooks:recordVerifiedDelivery");
const claimDelivery = makeFunctionReference<"mutation">("webhooks:claimDelivery");
const failDelivery = makeFunctionReference<"mutation">("webhooks:failDelivery");
const completeDelivery = makeFunctionReference<"mutation">("webhooks:completeDelivery");
const getDelivery = makeFunctionReference<"query">("webhooks:getDelivery");
const listDueDeliveries = makeFunctionReference<"query">("webhooks:listDueDeliveries");

const delivery = {
  deliveryId: "evt_123",
  bodyHash: `0x${"a".repeat(64)}`,
  receivedAt: 1_800_000_000,
  chainId: 8453,
  vaultAddressLower: "0x1000000000000000000000000000000000000001",
  transactionHashLower: `0x${"b".repeat(64)}`,
  logIndex: 4,
  blockNumber: 100,
  eventName: "GiftCreated",
};

describe("verified webhook delivery receipts", () => {
  it("deduplicates a retried delivery", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(recordVerifiedDelivery, delivery)).resolves.toMatchObject({
      operation: "inserted",
    });
    await expect(t.mutation(recordVerifiedDelivery, delivery)).resolves.toMatchObject({
      operation: "duplicate",
    });
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
  });

  it("rejects a reused delivery id with different authenticated content", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await expect(
      t.mutation(recordVerifiedDelivery, { ...delivery, bodyHash: `0x${"c".repeat(64)}` }),
    ).resolves.toEqual({ operation: "conflict" });
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
  });

  it("leases one worker and schedules a bounded retry after a transient failure", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await expect(
      t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt }),
    ).resolves.toMatchObject({ operation: "claimed", delivery: { attempts: 1 } });
    await expect(
      t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt + 1 }),
    ).resolves.toMatchObject({ operation: "leased" });
    await expect(
      t.mutation(failDelivery, {
        deliveryId: delivery.deliveryId,
        failureCode: "rpc_failure",
        retryable: true,
        now: delivery.receivedAt + 2,
      }),
    ).resolves.toEqual({ operation: "retry", delaySeconds: 15 });
    await expect(
      t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt + 3 }),
    ).resolves.toMatchObject({ operation: "deferred", retryAfterSeconds: 14 });
    await expect(
      t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt + 17 }),
    ).resolves.toMatchObject({ operation: "claimed", delivery: { attempts: 2 } });
  });

  it("moves a permanent failure to a terminal state", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt });
    await expect(
      t.mutation(failDelivery, {
        deliveryId: delivery.deliveryId,
        failureCode: "receipt_mismatch",
        retryable: false,
        now: delivery.receivedAt + 1,
      }),
    ).resolves.toEqual({ operation: "failed" });
    const stored = await t.run((ctx) => ctx.db.query("webhookDeliveries").unique());
    expect(stored).toMatchObject({ processingStatus: "failed", attempts: 1 });
  });
  it("deduplicates a replayed body that arrives under a new delivery id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await expect(
      t.mutation(recordVerifiedDelivery, { ...delivery, deliveryId: "evt_456" }),
    ).resolves.toMatchObject({ operation: "duplicate_body", processingStatus: "pending" });
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
  });

  it("refuses to claim a delivery that already reached the attempt ceiling", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("webhookDeliveries").unique();
      await ctx.db.patch(stored!._id, { attempts: 5, nextAttemptAt: 0 });
    });

    await expect(
      t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: delivery.receivedAt }),
    ).resolves.toEqual({ operation: "exhausted", attempts: 5 });
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").unique())).toMatchObject({
      processingStatus: "failed",
      failureCode: "attempts_exhausted",
    });
  });

  it("rejects malformed receipt values and unusable clocks", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(recordVerifiedDelivery, { ...delivery, deliveryId: "" })).rejects.toThrow();
    await expect(
      t.mutation(recordVerifiedDelivery, { ...delivery, bodyHash: "0xnothash" }),
    ).rejects.toThrow();
    await expect(
      t.mutation(recordVerifiedDelivery, { ...delivery, vaultAddressLower: "0xnope" }),
    ).rejects.toThrow();
    await expect(t.mutation(recordVerifiedDelivery, { ...delivery, blockNumber: -1 })).rejects.toThrow();
    await expect(t.mutation(claimDelivery, { deliveryId: delivery.deliveryId, now: -1 })).rejects.toThrow();
    await expect(t.query(listDueDeliveries, { now: 1.5, limit: 10 })).rejects.toThrow();
  });

  it("reports missing deliveries to every operator entry point", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(getDelivery, { deliveryId: "absent" })).resolves.toBeNull();
    await expect(t.mutation(claimDelivery, { deliveryId: "absent", now: 1_800_000_000 })).resolves.toEqual({
      operation: "missing",
    });
    await expect(
      t.mutation(completeDelivery, { deliveryId: "absent", eventKey: "k", duplicate: false }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(failDelivery, {
        deliveryId: "absent",
        failureCode: "rpc_failure",
        retryable: true,
        now: 1_800_000_000,
      }),
    ).resolves.toEqual({ operation: "missing" });
  });

  it("sweeps pending work first and then expired leases", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await t.mutation(recordVerifiedDelivery, {
      ...delivery,
      deliveryId: "evt_leased",
      bodyHash: `0x${"d".repeat(64)}`,
    });
    await t.mutation(claimDelivery, { deliveryId: "evt_leased", now: delivery.receivedAt });

    const due = await t.query(listDueDeliveries, { now: delivery.receivedAt + 3_600, limit: 10 });
    expect(due.map((entry: { deliveryId: string }) => entry.deliveryId)).toEqual(["evt_123", "evt_leased"]);
    const single = await t.query(listDueDeliveries, { now: delivery.receivedAt + 3_600, limit: 1 });
    expect(single).toHaveLength(1);
  });

  it("marks a completed delivery as applied or duplicate", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(recordVerifiedDelivery, delivery);
    await expect(
      t.mutation(completeDelivery, { deliveryId: delivery.deliveryId, eventKey: "k", duplicate: true }),
    ).resolves.toBe(true);
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").unique())).toMatchObject({
      processingStatus: "duplicate",
      eventKey: "k",
    });
  });
});
