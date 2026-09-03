import { ConvexError, v } from "convex/values";
import { isAddress, isHash } from "viem";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";

const canonicality = v.union(v.literal("tip"), v.literal("safe"));
const eventArgs = {
  chainId: v.number(),
  vaultAddressLower: v.string(),
  transactionHashLower: v.string(),
  transactionIndex: v.number(),
  logIndex: v.number(),
  blockNumber: v.number(),
  blockHashLower: v.string(),
  eventName: v.union(v.literal("GiftCreated"), v.literal("GiftClaimed")),
  giftIdDecimal: v.string(),
  senderLower: v.optional(v.string()),
  recipientLower: v.string(),
  stockLower: v.string(),
  amountRawDecimal: v.string(),
  unlockAt: v.optional(v.number()),
  noteHashLower: v.optional(v.string()),
  canonicality,
  source: v.union(v.literal("webhook"), v.literal("reconciler")),
  observedAt: v.number(),
};

type EventInput = {
  chainId: number;
  vaultAddressLower: string;
  transactionHashLower: string;
  transactionIndex: number;
  logIndex: number;
  blockNumber: number;
  blockHashLower: string;
  eventName: "GiftCreated" | "GiftClaimed";
  giftIdDecimal: string;
  senderLower?: string;
  recipientLower: string;
  stockLower: string;
  amountRawDecimal: string;
  unlockAt?: number;
  noteHashLower?: string;
  canonicality: "tip" | "safe";
  source: "webhook" | "reconciler";
  observedAt: number;
};

type GiftKey = Pick<EventInput, "chainId" | "vaultAddressLower" | "giftIdDecimal">;

function isLowerAddress(value: string) {
  return isAddress(value) && value === value.toLowerCase();
}

function isLowerHash(value: string) {
  return isHash(value) && value === value.toLowerCase();
}

function isCanonicalUint(value: string) {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed.toString() === value;
  } catch {
    return false;
  }
}

function validateEvent(input: EventInput) {
  const safeNumbers = [
    input.chainId,
    input.transactionIndex,
    input.logIndex,
    input.blockNumber,
    input.observedAt,
  ];
  if (input.unlockAt !== undefined) safeNumbers.push(input.unlockAt);
  if (safeNumbers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ConvexError({ code: "INVALID_EVENT_NUMBER" });
  }
  if (
    !isLowerAddress(input.vaultAddressLower) ||
    !isLowerAddress(input.recipientLower) ||
    !isLowerAddress(input.stockLower) ||
    (input.senderLower !== undefined && !isLowerAddress(input.senderLower)) ||
    !isLowerHash(input.transactionHashLower) ||
    !isLowerHash(input.blockHashLower) ||
    (input.noteHashLower !== undefined && !isLowerHash(input.noteHashLower)) ||
    !isCanonicalUint(input.giftIdDecimal) ||
    !isCanonicalUint(input.amountRawDecimal)
  ) {
    throw new ConvexError({ code: "INVALID_EVENT_WIRE_VALUE" });
  }
  const createdShape =
    input.senderLower !== undefined && input.unlockAt !== undefined && input.noteHashLower !== undefined;
  const claimedShape =
    input.senderLower === undefined && input.unlockAt === undefined && input.noteHashLower === undefined;
  if (
    (input.eventName === "GiftCreated" && !createdShape) ||
    (input.eventName === "GiftClaimed" && !claimedShape)
  ) {
    throw new ConvexError({ code: "INVALID_EVENT_SHAPE" });
  }
}

function eventBodyMatches(existing: Doc<"chainEvents">, input: EventInput) {
  return (
    existing.transactionIndex === input.transactionIndex &&
    existing.blockNumber === input.blockNumber &&
    existing.blockHashLower === input.blockHashLower &&
    existing.eventName === input.eventName &&
    existing.giftIdDecimal === input.giftIdDecimal &&
    existing.senderLower === input.senderLower &&
    existing.recipientLower === input.recipientLower &&
    existing.stockLower === input.stockLower &&
    existing.amountRawDecimal === input.amountRawDecimal &&
    existing.unlockAt === input.unlockAt &&
    existing.noteHashLower === input.noteHashLower
  );
}

async function rebuildGiftProjection(ctx: MutationCtx, key: GiftKey) {
  const allEvents = await ctx.db
    .query("chainEvents")
    .withIndex("by_gift", (queryBuilder) =>
      queryBuilder
        .eq("chainId", key.chainId)
        .eq("vaultAddressLower", key.vaultAddressLower)
        .eq("giftIdDecimal", key.giftIdDecimal),
    )
    .take(100);
  const events = allEvents.filter((event) => event.canonicality !== "orphaned");
  const createdEvents = events.filter((event) => event.eventName === "GiftCreated");
  const claimedEvents = events.filter((event) => event.eventName === "GiftClaimed");
  const existingGift = await ctx.db
    .query("gifts")
    .withIndex("by_gift_key", (queryBuilder) =>
      queryBuilder
        .eq("chainId", key.chainId)
        .eq("vaultAddressLower", key.vaultAddressLower)
        .eq("giftIdDecimal", key.giftIdDecimal),
    )
    .unique();

  if (createdEvents.length === 0) {
    if (existingGift) await ctx.db.delete(existingGift._id);
    return claimedEvents.length === 0 ? ("removed" as const) : ("quarantined_claim_before_create" as const);
  }
  if (createdEvents.length !== 1 || claimedEvents.length > 1) {
    throw new ConvexError({ code: "EVENT_CONFLICT" });
  }

  const created = createdEvents[0];
  const claimed = claimedEvents[0];
  if (
    created.senderLower === undefined ||
    created.unlockAt === undefined ||
    created.noteHashLower === undefined
  ) {
    throw new ConvexError({ code: "INVALID_STORED_CREATE" });
  }
  if (
    claimed &&
    (claimed.recipientLower !== created.recipientLower ||
      claimed.stockLower !== created.stockLower ||
      claimed.amountRawDecimal !== created.amountRawDecimal)
  ) {
    throw new ConvexError({ code: "EVENT_CONFLICT" });
  }

  const projection = {
    chainId: key.chainId,
    vaultAddressLower: key.vaultAddressLower,
    giftIdDecimal: key.giftIdDecimal,
    senderLower: created.senderLower,
    recipientLower: created.recipientLower,
    stockLower: created.stockLower,
    amountRawDecimal: created.amountRawDecimal,
    unlockAt: created.unlockAt,
    noteHashLower: created.noteHashLower,
    state: claimed ? ("claimed" as const) : ("active" as const),
    createdTxHashLower: created.transactionHashLower,
    createdLogIndex: created.logIndex,
    createdBlock: created.blockNumber,
    createdBlockHashLower: created.blockHashLower,
    createdCanonicality: created.canonicality as "tip" | "safe",
    claimedTxHashLower: claimed?.transactionHashLower,
    claimedLogIndex: claimed?.logIndex,
    claimedBlock: claimed?.blockNumber,
    claimedBlockHashLower: claimed?.blockHashLower,
    claimedCanonicality: claimed?.canonicality as "tip" | "safe" | undefined,
    lastChainVerifiedAt: Math.max(...events.map((event) => event.lastVerifiedAt)),
    projectionVersion: claimed ? 2 : 1,
  };

  if (existingGift) await ctx.db.patch(existingGift._id, projection);
  else await ctx.db.insert("gifts", projection);
  return "projected" as const;
}

export const applyCanonicalVaultLog = internalMutation({
  args: eventArgs,
  handler: async (ctx, input: EventInput) => {
    validateEvent(input);
    const existing = await ctx.db
      .query("chainEvents")
      .withIndex("by_event_inclusion", (queryBuilder) =>
        queryBuilder
          .eq("chainId", input.chainId)
          .eq("vaultAddressLower", input.vaultAddressLower)
          .eq("transactionHashLower", input.transactionHashLower)
          .eq("logIndex", input.logIndex)
          .eq("blockHashLower", input.blockHashLower),
      )
      .unique();

    const superseded = await ctx.db
      .query("chainEvents")
      .withIndex("by_event_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", input.chainId)
          .eq("vaultAddressLower", input.vaultAddressLower)
          .eq("transactionHashLower", input.transactionHashLower)
          .eq("logIndex", input.logIndex),
      )
      .collect();
    const affectedGiftKeys = new Map<string, GiftKey>();
    for (const prior of superseded) {
      if (prior.blockHashLower === input.blockHashLower || prior.canonicality === "orphaned") continue;
      await ctx.db.patch(prior._id, { canonicality: "orphaned", lastVerifiedAt: input.observedAt });
      affectedGiftKeys.set(prior.giftIdDecimal, prior);
    }

    let operation: "inserted" | "duplicate" = "inserted";
    if (existing) {
      if (!eventBodyMatches(existing, input)) throw new ConvexError({ code: "EVENT_CONFLICT" });
      await ctx.db.patch(existing._id, {
        canonicality: existing.canonicality === "safe" ? "safe" : input.canonicality,
        seenViaWebhook: existing.seenViaWebhook || input.source === "webhook",
        seenViaReconciler: existing.seenViaReconciler || input.source === "reconciler",
        lastVerifiedAt: Math.max(existing.lastVerifiedAt, input.observedAt),
      });
      operation = "duplicate";
    } else {
      await ctx.db.insert("chainEvents", {
        chainId: input.chainId,
        vaultAddressLower: input.vaultAddressLower,
        transactionHashLower: input.transactionHashLower,
        transactionIndex: input.transactionIndex,
        logIndex: input.logIndex,
        blockNumber: input.blockNumber,
        blockHashLower: input.blockHashLower,
        eventName: input.eventName,
        giftIdDecimal: input.giftIdDecimal,
        senderLower: input.senderLower,
        recipientLower: input.recipientLower,
        stockLower: input.stockLower,
        amountRawDecimal: input.amountRawDecimal,
        unlockAt: input.unlockAt,
        noteHashLower: input.noteHashLower,
        canonicality: input.canonicality,
        seenViaWebhook: input.source === "webhook",
        seenViaReconciler: input.source === "reconciler",
        firstSeenAt: input.observedAt,
        lastVerifiedAt: input.observedAt,
      });
    }

    affectedGiftKeys.set(input.giftIdDecimal, input);
    let projection: Awaited<ReturnType<typeof rebuildGiftProjection>> = "removed";
    for (const key of affectedGiftKeys.values()) projection = await rebuildGiftProjection(ctx, key);
    if (projection === "quarantined_claim_before_create") return { operation: projection };
    return { operation };
  },
});

export const setEventCanonicality = internalMutation({
  args: {
    chainId: v.number(),
    vaultAddressLower: v.string(),
    transactionHashLower: v.string(),
    logIndex: v.number(),
    blockHashLower: v.string(),
    canonicality: v.union(v.literal("safe"), v.literal("orphaned")),
    observedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("chainEvents")
      .withIndex("by_event_inclusion", (queryBuilder) =>
        queryBuilder
          .eq("chainId", args.chainId)
          .eq("vaultAddressLower", args.vaultAddressLower)
          .eq("transactionHashLower", args.transactionHashLower)
          .eq("logIndex", args.logIndex)
          .eq("blockHashLower", args.blockHashLower),
      )
      .unique();
    if (!event) return { operation: "missing" as const };
    if (event.canonicality === args.canonicality) return { operation: "unchanged" as const };
    await ctx.db.patch(event._id, {
      canonicality: args.canonicality,
      lastVerifiedAt: Math.max(event.lastVerifiedAt, args.observedAt),
    });
    await rebuildGiftProjection(ctx, event);
    return { operation: "updated" as const };
  },
});

export const listEventsAboveBlock = internalQuery({
  args: {
    chainId: v.number(),
    vaultAddressLower: v.string(),
    aboveBlock: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 500);
    const events = await ctx.db
      .query("chainEvents")
      .withIndex("by_block", (queryBuilder) =>
        queryBuilder
          .eq("chainId", args.chainId)
          .eq("vaultAddressLower", args.vaultAddressLower)
          .gt("blockNumber", args.aboveBlock),
      )
      .order("desc")
      .take(limit);
    return events.filter((event) => event.canonicality !== "orphaned");
  },
});

export const listTipEventsThroughBlock = internalQuery({
  args: {
    chainId: v.number(),
    vaultAddressLower: v.string(),
    throughBlock: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 500);
    return ctx.db
      .query("chainEvents")
      .withIndex("by_canonicality", (queryBuilder) =>
        queryBuilder
          .eq("chainId", args.chainId)
          .eq("vaultAddressLower", args.vaultAddressLower)
          .eq("canonicality", "tip")
          .lte("blockNumber", args.throughBlock),
      )
      .order("asc")
      .take(limit);
  },
});
