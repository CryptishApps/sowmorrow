import { ConvexError, v } from "convex/values";
import { isAddress, isHash } from "viem";
import { internalMutation, internalQuery } from "./_generated/server";

export const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 60;
const deliveryIdArg = { deliveryId: v.string() };
const failureCode = v.union(
  v.literal("configuration"),
  v.literal("rpc_failure"),
  v.literal("receipt_failed"),
  v.literal("receipt_mismatch"),
  v.literal("log_missing"),
  v.literal("log_decode_failed"),
  v.literal("event_conflict"),
);

function assertSafeTime(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError({ code: "INVALID_WEBHOOK_TIME" });
  }
}

export const recordVerifiedDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    bodyHash: v.string(),
    receivedAt: v.number(),
    chainId: v.number(),
    vaultAddressLower: v.string(),
    transactionHashLower: v.string(),
    logIndex: v.number(),
    blockNumber: v.number(),
    eventName: v.union(v.literal("GiftCreated"), v.literal("GiftClaimed")),
  },
  handler: async (ctx, args) => {
    if (
      args.deliveryId.length === 0 ||
      args.deliveryId.length > 200 ||
      !isHash(args.bodyHash) ||
      args.bodyHash !== args.bodyHash.toLowerCase() ||
      !isAddress(args.vaultAddressLower) ||
      args.vaultAddressLower !== args.vaultAddressLower.toLowerCase() ||
      !isHash(args.transactionHashLower) ||
      args.transactionHashLower !== args.transactionHashLower.toLowerCase() ||
      [args.receivedAt, args.chainId, args.logIndex, args.blockNumber].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      )
    ) {
      throw new ConvexError({ code: "INVALID_WEBHOOK_RECEIPT" });
    }

    const existing = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery_id", (queryBuilder) =>
        queryBuilder.eq("provider", "cdp").eq("deliveryId", args.deliveryId),
      )
      .unique();
    if (existing) {
      if (existing.bodyHash !== args.bodyHash) return { operation: "conflict" as const };
      return {
        operation: "duplicate" as const,
        id: existing._id,
        processingStatus: existing.processingStatus,
      };
    }

    const sameBody = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_body_hash", (queryBuilder) => queryBuilder.eq("bodyHash", args.bodyHash))
      .first();
    if (sameBody) {
      return {
        operation: "duplicate_body" as const,
        id: sameBody._id,
        processingStatus: sameBody.processingStatus,
      };
    }

    const id = await ctx.db.insert("webhookDeliveries", {
      provider: "cdp",
      ...args,
      processingStatus: "pending",
      attempts: 0,
      nextAttemptAt: args.receivedAt,
    });
    return { operation: "inserted" as const, id, processingStatus: "pending" as const };
  },
});

export const getDelivery = internalQuery({
  args: deliveryIdArg,
  handler: async (ctx, { deliveryId }) => {
    return ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery_id", (queryBuilder) =>
        queryBuilder.eq("provider", "cdp").eq("deliveryId", deliveryId),
      )
      .unique();
  },
});

export const claimDelivery = internalMutation({
  args: { deliveryId: v.string(), now: v.number() },
  handler: async (ctx, { deliveryId, now }) => {
    assertSafeTime(now);
    const delivery = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery_id", (queryBuilder) =>
        queryBuilder.eq("provider", "cdp").eq("deliveryId", deliveryId),
      )
      .unique();
    if (!delivery) return { operation: "missing" as const };
    if (
      delivery.processingStatus === "applied" ||
      delivery.processingStatus === "duplicate" ||
      delivery.processingStatus === "failed"
    ) {
      return { operation: "already_processed" as const };
    }
    if (
      delivery.processingStatus === "processing" &&
      delivery.leaseUntil !== undefined &&
      delivery.leaseUntil > now
    ) {
      return {
        operation: "leased" as const,
        retryAfterSeconds: delivery.leaseUntil - now,
      };
    }
    if (delivery.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(delivery._id, {
        processingStatus: "failed",
        failureCode: delivery.failureCode ?? "attempts_exhausted",
        leaseUntil: undefined,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      });
      return { operation: "exhausted" as const, attempts: delivery.attempts };
    }
    if (delivery.nextAttemptAt > now) {
      return {
        operation: "deferred" as const,
        retryAfterSeconds: delivery.nextAttemptAt - now,
      };
    }

    const attempts = delivery.attempts + 1;
    const leaseUntil = now + LEASE_SECONDS;
    await ctx.db.patch(delivery._id, {
      processingStatus: "processing",
      attempts,
      lastAttemptAt: now,
      leaseUntil,
      nextAttemptAt: leaseUntil,
    });
    return {
      operation: "claimed" as const,
      delivery: {
        ...delivery,
        processingStatus: "processing" as const,
        attempts,
        lastAttemptAt: now,
        leaseUntil,
        nextAttemptAt: leaseUntil,
      },
    };
  },
});

export const completeDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    eventKey: v.string(),
    duplicate: v.boolean(),
  },
  handler: async (ctx, { deliveryId, eventKey, duplicate }) => {
    const delivery = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery_id", (queryBuilder) =>
        queryBuilder.eq("provider", "cdp").eq("deliveryId", deliveryId),
      )
      .unique();
    if (!delivery) return false;
    await ctx.db.patch(delivery._id, {
      eventKey,
      processingStatus: duplicate ? "duplicate" : "applied",
      failureCode: undefined,
      leaseUntil: undefined,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });
    return true;
  },
});

export const failDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    failureCode,
    retryable: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, { deliveryId, failureCode: code, retryable, now }) => {
    assertSafeTime(now);
    const delivery = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_delivery_id", (queryBuilder) =>
        queryBuilder.eq("provider", "cdp").eq("deliveryId", deliveryId),
      )
      .unique();
    if (!delivery) return { operation: "missing" as const };
    if (retryable && delivery.attempts < MAX_ATTEMPTS) {
      const delaySeconds = Math.min(15 * 2 ** Math.max(delivery.attempts - 1, 0), 600);
      await ctx.db.patch(delivery._id, {
        processingStatus: "pending",
        failureCode: code,
        leaseUntil: undefined,
        nextAttemptAt: now + delaySeconds,
      });
      return { operation: "retry" as const, delaySeconds };
    }
    await ctx.db.patch(delivery._id, {
      processingStatus: "failed",
      failureCode: code,
      leaseUntil: undefined,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    });
    return { operation: "failed" as const };
  },
});

export const listDueDeliveries = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, { now, limit }) => {
    assertSafeTime(now);
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
    const pending = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next_attempt", (queryBuilder) =>
        queryBuilder.eq("processingStatus", "pending").lte("nextAttemptAt", now),
      )
      .take(boundedLimit);
    if (pending.length === boundedLimit) return pending;
    const expiredLeases = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next_attempt", (queryBuilder) =>
        queryBuilder.eq("processingStatus", "processing").lte("nextAttemptAt", now),
      )
      .take(boundedLimit - pending.length);
    return [...pending, ...expiredLeases];
  },
});
