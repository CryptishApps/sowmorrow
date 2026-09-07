import { deploymentRegistry } from "../lib/contracts/manifests";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAddress, isAddress } from "viem";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { assertManifestChainId, clampPagination } from "./bounds";

const intent = v.union(v.literal("verify"), v.literal("retire"));

const proposalArgs = {
  chainId: v.number(),
  addressChecksum: v.string(),
  intent,
  symbol: v.string(),
  name: v.string(),
  decimals: v.number(),
  b20Generation: v.literal("beryl"),
  sortOrder: v.number(),
  evidenceUrl: v.string(),
  evidenceHash: v.string(),
  reviewer: v.string(),
  now: v.number(),
};

function assertChecksumAddress(addressChecksum: string) {
  if (!isAddress(addressChecksum) || getAddress(addressChecksum) !== addressChecksum) {
    throw new ConvexError({ code: "INVALID_CHECKSUM_ADDRESS" });
  }
  return addressChecksum.toLowerCase();
}

function assertReviewer(reviewer: string) {
  if (reviewer.length === 0 || reviewer.length > 200) throw new ConvexError({ code: "INVALID_REVIEWER" });
  return reviewer;
}

function assertEvidence(evidenceUrl: string, evidenceHash: string) {
  if (
    evidenceUrl.length === 0 ||
    evidenceUrl.length > 2_000 ||
    evidenceHash.length === 0 ||
    evidenceHash.length > 200
  ) {
    throw new ConvexError({ code: "INVALID_REVIEW_EVIDENCE" });
  }
}

export const proposeReviewedStock = internalMutation({
  args: proposalArgs,
  handler: async (ctx, args) => {
    const addressLower = assertChecksumAddress(args.addressChecksum);
    assertReviewer(args.reviewer);
    assertEvidence(args.evidenceUrl, args.evidenceHash);
    if (args.symbol.length === 0 || args.name.length === 0) {
      throw new ConvexError({ code: "INVALID_CATALOG_RECORD" });
    }
    if (
      !Number.isSafeInteger(args.chainId) ||
      !Number.isSafeInteger(args.decimals) ||
      !Number.isSafeInteger(args.sortOrder) ||
      !Number.isSafeInteger(args.now)
    ) {
      throw new ConvexError({ code: "INVALID_CATALOG_NUMBER" });
    }

    const record = {
      chainId: args.chainId,
      addressLower,
      addressChecksum: args.addressChecksum,
      intent: args.intent,
      symbol: args.symbol,
      name: args.name,
      decimals: args.decimals,
      b20Generation: args.b20Generation,
      sortOrder: args.sortOrder,
      evidenceUrl: args.evidenceUrl,
      evidenceHash: args.evidenceHash,
      proposedBy: args.reviewer,
      proposedAt: args.now,
      approvedBy: undefined,
      approvedAt: undefined,
      status: "proposed" as const,
    };

    const existing = await ctx.db
      .query("stockPromotions")
      .withIndex("by_chain_address_intent", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower).eq("intent", args.intent),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, record);
      return { operation: "replaced" as const, id: existing._id };
    }
    const id = await ctx.db.insert("stockPromotions", record);
    return { operation: "proposed" as const, id };
  },
});

export const approveReviewedStock = internalMutation({
  args: {
    chainId: v.number(),
    addressChecksum: v.string(),
    intent,
    evidenceHash: v.string(),
    reviewer: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const addressLower = assertChecksumAddress(args.addressChecksum);
    assertReviewer(args.reviewer);

    const proposal = await ctx.db
      .query("stockPromotions")
      .withIndex("by_chain_address_intent", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower).eq("intent", args.intent),
      )
      .unique();
    if (!proposal) throw new ConvexError({ code: "NO_OPEN_PROPOSAL" });
    if (proposal.status !== "proposed") throw new ConvexError({ code: "PROPOSAL_ALREADY_APPROVED" });
    if (proposal.proposedBy === args.reviewer) throw new ConvexError({ code: "SECOND_REVIEWER_REQUIRED" });
    if (proposal.evidenceHash !== args.evidenceHash) {
      throw new ConvexError({ code: "REVIEW_EVIDENCE_MISMATCH" });
    }

    const existing = await ctx.db
      .query("stocks")
      .withIndex("by_chain_address", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower),
      )
      .unique();
    if (args.intent === "retire" && !existing) throw new ConvexError({ code: "NO_REVIEWED_STOCK" });

    const record = {
      chainId: args.chainId,
      addressLower,
      addressChecksum: proposal.addressChecksum,
      symbol: proposal.symbol,
      name: proposal.name,
      decimals: proposal.decimals,
      reviewStatus: args.intent === "verify" ? ("verified" as const) : ("retired" as const),
      reviewedSourceUrl: proposal.evidenceUrl,
      reviewedSourceHash: proposal.evidenceHash,
      reviewedAt: args.now,
      b20Generation: proposal.b20Generation,
      sortOrder: proposal.sortOrder,
      vaultSupported: existing?.vaultSupported ?? ("unknown" as const),
      proposedBy: proposal.proposedBy,
      approvedBy: args.reviewer,
    };

    if (existing) await ctx.db.patch(existing._id, record);
    else await ctx.db.insert("stocks", record);

    await ctx.db.patch(proposal._id, {
      status: "approved",
      approvedBy: args.reviewer,
      approvedAt: args.now,
    });

    const candidate = await ctx.db
      .query("stockCandidates")
      .withIndex("by_chain_address", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower),
      )
      .unique();
    if (candidate && args.intent === "verify") {
      await ctx.db.patch(candidate._id, { reviewDisposition: "promoted", reviewedAt: args.now });
    }

    return { operation: args.intent === "verify" ? ("verified" as const) : ("retired" as const) };
  },
});

export const setVaultSupport = internalMutation({
  args: {
    chainId: v.number(),
    addressLower: v.string(),
    vaultSupported: v.boolean(),
    checkedAt: v.number(),
    checkedBlock: v.number(),
  },
  handler: async (ctx, args) => {
    const stock = await ctx.db
      .query("stocks")
      .withIndex("by_chain_address", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", args.addressLower),
      )
      .unique();
    if (!stock) return { operation: "missing" as const };
    await ctx.db.patch(stock._id, {
      vaultSupported: args.vaultSupported,
      vaultSupportCheckedAt: args.checkedAt,
      vaultSupportCheckedBlock: args.checkedBlock,
    });
    return { operation: "updated" as const };
  },
});

export const listVerified = query({
  args: { chainId: v.number() },
  handler: async (ctx, { chainId }) => {
    const boundedChainId = assertManifestChainId(chainId);
    const reviewed = await ctx.db
      .query("stocks")
      .withIndex("by_chain_status_order", (queryBuilder) =>
        queryBuilder.eq("chainId", boundedChainId).eq("reviewStatus", "verified"),
      )
      .take(100);
    return reviewed.filter((stock) => stock.vaultSupported === true);
  },
});

export const pageVerified = query({
  args: { chainId: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { chainId, paginationOpts }) => {
    const boundedChainId = assertManifestChainId(chainId);
    return ctx.db
      .query("stocks")
      .withIndex("by_chain_status_order", (queryBuilder) =>
        queryBuilder.eq("chainId", boundedChainId).eq("reviewStatus", "verified"),
      )
      .paginate(clampPagination(paginationOpts));
  },
});

export const listMonitoredStocks = internalQuery({
  args: { chainId: v.number(), limit: v.number() },
  handler: async (ctx, { chainId, limit }) => {
    const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
    const verified = await ctx.db
      .query("stocks")
      .withIndex("by_chain_status_order", (queryBuilder) =>
        queryBuilder.eq("chainId", chainId).eq("reviewStatus", "verified"),
      )
      .take(bounded);
    const retired = await ctx.db
      .query("stocks")
      .withIndex("by_chain_status_order", (queryBuilder) =>
        queryBuilder.eq("chainId", chainId).eq("reviewStatus", "retired"),
      )
      .take(Math.max(bounded - verified.length, 1));
    const assets = new Map(
      [...verified, ...retired].map((stock) => [
        stock.addressLower,
        {
          addressLower: stock.addressLower,
          addressChecksum: stock.addressChecksum,
          symbol: stock.symbol,
        },
      ]),
    );
    for (const stock of Object.values(deploymentRegistry).find((manifest) => manifest?.chainId === chainId)
      ?.stocks ?? []) {
      assets.set(stock.address.toLowerCase(), {
        addressLower: stock.address.toLowerCase(),
        addressChecksum: stock.address,
        symbol: stock.symbol,
      });
    }
    let afterStock = "";
    for (;;) {
      const gift = await ctx.db
        .query("gifts")
        .withIndex("by_chain_stock", (q) => q.eq("chainId", chainId).gt("stockLower", afterStock))
        .first();
      if (!gift) break;
      afterStock = gift.stockLower;
      if (!assets.has(afterStock))
        assets.set(afterStock, {
          addressLower: afterStock,
          addressChecksum: getAddress(afterStock),
          symbol: "B20",
        });
      if (assets.size > bounded) throw new ConvexError({ code: "MONITOR_CAPACITY_EXCEEDED" });
    }
    if (assets.size > bounded || verified.length === bounded || retired.length === bounded) {
      throw new ConvexError({ code: "MONITOR_CAPACITY_EXCEEDED" });
    }
    return [...assets.values()];
  },
});

export const quarantineCandidate = internalMutation({
  args: {
    chainId: v.number(),
    addressChecksum: v.string(),
    factoryAddressLower: v.string(),
    creatorAddressLower: v.string(),
    creationTxHashLower: v.string(),
    creationLogIndex: v.number(),
    creationBlock: v.number(),
    creationBlockHashLower: v.string(),
    observedName: v.string(),
    observedSymbol: v.string(),
    observedDecimals: v.number(),
    observedVariant: v.literal("asset"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const addressLower = assertChecksumAddress(args.addressChecksum);
    const reviewed = await ctx.db
      .query("stocks")
      .withIndex("by_chain_address", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower),
      )
      .unique();
    if (reviewed) return { operation: "already_reviewed" as const };

    const existing = await ctx.db
      .query("stockCandidates")
      .withIndex("by_chain_address", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("addressLower", addressLower),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: args.now });
      return { operation: "seen_again" as const };
    }

    await ctx.db.insert("stockCandidates", {
      chainId: args.chainId,
      addressLower,
      addressChecksum: args.addressChecksum,
      factoryAddressLower: args.factoryAddressLower,
      creatorAddressLower: args.creatorAddressLower,
      creationTxHashLower: args.creationTxHashLower,
      creationLogIndex: args.creationLogIndex,
      creationBlock: args.creationBlock,
      creationBlockHashLower: args.creationBlockHashLower,
      observedName: args.observedName,
      observedSymbol: args.observedSymbol,
      observedDecimals: args.observedDecimals,
      observedVariant: args.observedVariant,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
      reviewDisposition: "unreviewed",
    });
    return { operation: "quarantined" as const };
  },
});

export const listCandidates = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("stockCandidates")
      .withIndex("by_disposition_seen", (queryBuilder) => queryBuilder.eq("reviewDisposition", "unreviewed"))
      .take(Math.min(Math.max(Math.floor(limit), 1), 200)),
});
