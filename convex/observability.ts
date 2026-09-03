import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const syncPipelineValidator = v.union(
  v.literal("vault-events"),
  v.literal("factory-candidates"),
  v.literal("solvency-monitor"),
  v.literal("operator-repair"),
);

export const syncOutcomeValidator = v.union(
  v.literal("indexed"),
  v.literal("caught_up"),
  v.literal("promoted_tip_events"),
  v.literal("rewound"),
  v.literal("halted"),
  v.literal("not_configured"),
  v.literal("chain_mismatch"),
  v.literal("provider_split"),
  v.literal("failed"),
  v.literal("completed"),
);

export const syncErrorCodeValidator = v.union(
  v.literal("rpc_failure"),
  v.literal("receipt_failed"),
  v.literal("receipt_mismatch"),
  v.literal("log_decode_failed"),
  v.literal("projection_failure"),
  v.literal("cursor_conflict"),
  v.literal("reorg_beyond_checkpoints"),
  v.literal("missing_block_hash"),
  v.literal("provider_disagreement"),
  v.literal("unsafe_number"),
);

const monitorSignalValidator = v.union(
  v.object({
    kind: v.literal("solvency"),
    stockLower: v.string(),
    totalEscrowedDecimal: v.string(),
    vaultBalanceDecimal: v.string(),
    status: v.union(v.literal("healthy"), v.literal("insolvent")),
  }),
  v.object({
    kind: v.literal("lag"),
    safeHeadBlock: v.number(),
    cursorBlock: v.number(),
    lagBlocks: v.number(),
  }),
  v.object({
    kind: v.literal("provider_split"),
    blockNumber: v.number(),
    primaryBlockHashLower: v.string(),
    secondaryBlockHashLower: v.string(),
  }),
);

function boundedLimit(limit: number, ceiling: number) {
  return Math.min(Math.max(Math.floor(limit), 1), ceiling);
}

export const recordSyncRun = internalMutation({
  args: {
    pipeline: syncPipelineValidator,
    chainId: v.number(),
    contractAddressLower: v.string(),
    startedAt: v.number(),
    endedAt: v.number(),
    fromBlock: v.optional(v.number()),
    toBlock: v.optional(v.number()),
    safeHeadBlock: v.optional(v.number()),
    eventsApplied: v.optional(v.number()),
    outcome: syncOutcomeValidator,
    errorCode: v.optional(syncErrorCodeValidator),
    operator: v.optional(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("syncRuns", args),
});

export const recordMonitorSignal = internalMutation({
  args: {
    chainId: v.number(),
    vaultAddressLower: v.string(),
    observedAt: v.number(),
    signal: monitorSignalValidator,
  },
  handler: async (ctx, args) => ctx.db.insert("monitorSignals", args),
});

export const recentSyncRuns = internalQuery({
  args: { chainId: v.number(), limit: v.number() },
  handler: async (ctx, { chainId, limit }) => {
    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_ended")
      .order("desc")
      .take(boundedLimit(limit, 200));
    return runs.filter((run) => run.chainId === chainId);
  },
});

export const recentSignals = internalQuery({
  args: { chainId: v.number(), limit: v.number() },
  handler: async (ctx, { chainId, limit }) =>
    ctx.db
      .query("monitorSignals")
      .withIndex("by_chain_observed", (queryBuilder) => queryBuilder.eq("chainId", chainId))
      .order("desc")
      .take(boundedLimit(limit, 200)),
});
