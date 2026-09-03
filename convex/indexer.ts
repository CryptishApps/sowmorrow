import { ConvexError, v } from "convex/values";
import { getAddress, isAddress, isHash } from "viem";
import { internalMutation, internalQuery } from "./_generated/server";

export const MAX_CHECKPOINTS = 64;

const pipeline = v.union(v.literal("vault-events"), v.literal("factory-candidates"));
const cursorKey = {
  pipeline,
  chainId: v.number(),
  contractAddressLower: v.string(),
};
const cursorFailureCode = v.union(v.literal("cursor_hash_mismatch"), v.literal("reorg_beyond_checkpoints"));

type Checkpoint = { blockNumber: number; blockHashLower: string };

function assertBlockHash(value: string) {
  if (!isHash(value) || value !== value.toLowerCase()) {
    throw new ConvexError({ code: "INVALID_BLOCK_HASH" });
  }
}

function assertBlockNumber(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError({ code: "INVALID_BLOCK_NUMBER" });
  }
}

function withCheckpoint(existing: Checkpoint[], checkpoint: Checkpoint) {
  const kept = existing.filter((entry) => entry.blockNumber < checkpoint.blockNumber);
  return [...kept, checkpoint].slice(-MAX_CHECKPOINTS);
}

export const getCursor = internalQuery({
  args: cursorKey,
  handler: async (ctx, { pipeline: name, chainId, contractAddressLower }) =>
    ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", name)
          .eq("chainId", chainId)
          .eq("contractAddressLower", contractAddressLower),
      )
      .unique(),
});

export const initializeCursor = internalMutation({
  args: { ...cursorKey, deploymentBlock: v.number(), now: v.number() },
  handler: async (ctx, { pipeline: name, chainId, contractAddressLower, deploymentBlock, now }) => {
    assertBlockNumber(deploymentBlock);
    const existing = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", name)
          .eq("chainId", chainId)
          .eq("contractAddressLower", contractAddressLower),
      )
      .unique();
    if (existing) return existing;
    const id = await ctx.db.insert("indexerCursors", {
      pipeline: name,
      chainId,
      contractAddressLower,
      nextBlock: deploymentBlock,
      checkpoints: [],
      state: "active",
      updatedAt: now,
    });
    return ctx.db.get(id);
  },
});

export const advanceCursor = internalMutation({
  args: {
    ...cursorKey,
    expectedNextBlock: v.number(),
    committedBlock: v.number(),
    committedBlockHashLower: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertBlockNumber(args.committedBlock);
    assertBlockHash(args.committedBlockHashLower);
    const cursor = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", args.pipeline)
          .eq("chainId", args.chainId)
          .eq("contractAddressLower", args.contractAddressLower),
      )
      .unique();
    if (!cursor || cursor.state !== "active" || cursor.nextBlock !== args.expectedNextBlock) {
      throw new ConvexError({ code: "CURSOR_COMPARE_AND_SET_FAILED" });
    }
    await ctx.db.patch(cursor._id, {
      nextBlock: args.committedBlock + 1,
      lastCommittedBlock: args.committedBlock,
      lastCommittedBlockHashLower: args.committedBlockHashLower,
      checkpoints: withCheckpoint(cursor.checkpoints, {
        blockNumber: args.committedBlock,
        blockHashLower: args.committedBlockHashLower,
      }),
      updatedAt: args.now,
      failureCode: undefined,
    });
    return { operation: "advanced" as const, nextBlock: args.committedBlock + 1 };
  },
});

export const rewindCursor = internalMutation({
  args: {
    ...cursorKey,
    ancestorBlock: v.number(),
    ancestorBlockHashLower: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertBlockNumber(args.ancestorBlock);
    assertBlockHash(args.ancestorBlockHashLower);
    const cursor = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", args.pipeline)
          .eq("chainId", args.chainId)
          .eq("contractAddressLower", args.contractAddressLower),
      )
      .unique();
    if (!cursor) throw new ConvexError({ code: "CURSOR_MISSING" });
    await ctx.db.patch(cursor._id, {
      nextBlock: args.ancestorBlock + 1,
      lastCommittedBlock: args.ancestorBlock,
      lastCommittedBlockHashLower: args.ancestorBlockHashLower,
      checkpoints: withCheckpoint(
        cursor.checkpoints.filter((entry) => entry.blockNumber <= args.ancestorBlock),
        { blockNumber: args.ancestorBlock, blockHashLower: args.ancestorBlockHashLower },
      ),
      state: "active",
      failureCode: undefined,
      updatedAt: args.now,
    });
    return { operation: "rewound" as const, nextBlock: args.ancestorBlock + 1 };
  },
});

export const haltCursor = internalMutation({
  args: { ...cursorKey, failureCode: cursorFailureCode, now: v.number() },
  handler: async (ctx, { pipeline: name, chainId, contractAddressLower, failureCode, now }) => {
    const cursor = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", name)
          .eq("chainId", chainId)
          .eq("contractAddressLower", contractAddressLower),
      )
      .unique();
    if (!cursor) return { operation: "missing" as const };
    await ctx.db.patch(cursor._id, { state: "halted", failureCode, updatedAt: now });
    return { operation: "halted" as const };
  },
});

export const resumeHaltedCursor = internalMutation({
  args: {
    ...cursorKey,
    resetToBlock: v.number(),
    resetToBlockHashLower: v.string(),
    operator: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertBlockNumber(args.resetToBlock);
    assertBlockHash(args.resetToBlockHashLower);
    if (args.operator.length === 0 || args.operator.length > 200) {
      throw new ConvexError({ code: "INVALID_OPERATOR" });
    }
    const cursor = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder
          .eq("pipeline", args.pipeline)
          .eq("chainId", args.chainId)
          .eq("contractAddressLower", args.contractAddressLower),
      )
      .unique();
    if (!cursor) return { operation: "missing" as const };
    if (cursor.state !== "halted") return { operation: "not_halted" as const };
    const known = cursor.checkpoints.some(
      (entry) =>
        entry.blockNumber === args.resetToBlock && entry.blockHashLower === args.resetToBlockHashLower,
    );
    if (!known) throw new ConvexError({ code: "UNKNOWN_RESET_CHECKPOINT" });
    await ctx.db.patch(cursor._id, {
      nextBlock: args.resetToBlock + 1,
      lastCommittedBlock: args.resetToBlock,
      lastCommittedBlockHashLower: args.resetToBlockHashLower,
      checkpoints: cursor.checkpoints.filter((entry) => entry.blockNumber <= args.resetToBlock),
      state: "active",
      failureCode: undefined,
      repairedBy: args.operator,
      repairedAt: args.now,
      updatedAt: args.now,
    });
    return { operation: "resumed" as const, nextBlock: args.resetToBlock + 1 };
  },
});

export const recordActiveDeployment = internalMutation({
  args: {
    chainId: v.number(),
    network: v.union(v.literal("base-mainnet"), v.literal("base-sepolia")),
    vaultAddressChecksum: v.string(),
    deploymentBlock: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !isAddress(args.vaultAddressChecksum) ||
      getAddress(args.vaultAddressChecksum) !== args.vaultAddressChecksum
    ) {
      throw new ConvexError({ code: "INVALID_CHECKSUM_ADDRESS" });
    }
    assertBlockNumber(args.deploymentBlock);
    const vaultAddressLower = args.vaultAddressChecksum.toLowerCase();
    const record = {
      chainId: args.chainId,
      network: args.network,
      vaultAddressLower,
      vaultAddressChecksum: args.vaultAddressChecksum,
      deploymentBlock: args.deploymentBlock,
      active: true,
      updatedAt: args.now,
    };
    const existing = await ctx.db
      .query("deployments")
      .withIndex("by_chain_vault", (queryBuilder) =>
        queryBuilder.eq("chainId", args.chainId).eq("vaultAddressLower", vaultAddressLower),
      )
      .unique();
    if (existing) {
      if (existing.deploymentBlock === args.deploymentBlock && existing.active) {
        return { operation: "unchanged" as const };
      }
      await ctx.db.patch(existing._id, record);
      return { operation: "updated" as const };
    }
    await ctx.db.insert("deployments", record);
    return { operation: "inserted" as const };
  },
});
