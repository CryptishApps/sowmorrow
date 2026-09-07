import { noteMatchesGift } from "./noteIntegrity";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import {
  assertGiftId,
  assertManifestChainId,
  assertManifestVault,
  assertRecipientAddress,
  clampPagination,
} from "./bounds";

export const forRecipient = query({
  args: {
    chainId: v.number(),
    recipientLower: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { chainId, recipientLower, paginationOpts }) => {
    assertManifestChainId(chainId);
    assertRecipientAddress(recipientLower);
    return ctx.db
      .query("gifts")
      .withIndex("by_recipient_chain", (queryBuilder) =>
        queryBuilder.eq("recipientLower", recipientLower).eq("chainId", chainId),
      )
      .order("desc")
      .paginate(clampPagination(paginationOpts));
  },
});

export const detail = query({
  args: { chainId: v.number(), vault: v.string(), giftId: v.string() },
  handler: async (ctx, { chainId, vault, giftId }) => {
    const boundedChainId = assertManifestChainId(chainId);
    const vaultAddressLower = assertManifestVault(chainId, vault);
    const giftIdDecimal = assertGiftId(giftId);
    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_gift_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", boundedChainId)
          .eq("vaultAddressLower", vaultAddressLower)
          .eq("giftIdDecimal", giftIdDecimal),
      )
      .unique();
    if (!gift) return null;
    const note = await ctx.db
      .query("noteAttachments")
      .withIndex("by_gift_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", boundedChainId)
          .eq("vaultAddressLower", vaultAddressLower)
          .eq("giftIdDecimal", giftIdDecimal),
      )
      .unique();
    return {
      gift,
      note:
        note && noteMatchesGift(note, gift)
          ? { noteUtf8: note.noteUtf8, noteHashLower: note.noteHashLower }
          : null,
    };
  },
});

export const freshness = query({
  args: { chainId: v.number() },
  handler: async (ctx, { chainId }) => {
    const boundedChainId = assertManifestChainId(chainId);
    const cursor = await ctx.db
      .query("indexerCursors")
      .withIndex("by_pipeline_chain_contract", (queryBuilder) =>
        queryBuilder.eq("pipeline", "vault-events").eq("chainId", boundedChainId),
      )
      .first();
    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_pipeline_chain_ended", (queryBuilder) =>
        queryBuilder.eq("pipeline", "vault-events").eq("chainId", boundedChainId),
      )
      .order("desc")
      .take(1);
    const lastRun = runs[0] ?? null;
    const safeHeadBlock = lastRun?.safeHeadBlock ?? null;
    const cursorBlock = cursor?.lastCommittedBlock ?? null;
    return {
      chainId: boundedChainId,
      safeHeadBlock,
      cursor: cursor
        ? {
            nextBlock: cursor.nextBlock,
            lastCommittedBlock: cursor.lastCommittedBlock ?? null,
            lastCommittedBlockHashLower: cursor.lastCommittedBlockHashLower ?? null,
            state: cursor.state,
            failureCode: cursor.failureCode ?? null,
          }
        : null,
      lagBlocks: safeHeadBlock !== null && cursorBlock !== null ? safeHeadBlock - cursorBlock : null,
      lastSyncRun: lastRun
        ? {
            startedAt: lastRun.startedAt,
            endedAt: lastRun.endedAt,
            outcome: lastRun.outcome,
            errorCode: lastRun.errorCode ?? null,
            fromBlock: lastRun.fromBlock ?? null,
            toBlock: lastRun.toBlock ?? null,
            eventsApplied: lastRun.eventsApplied ?? null,
          }
        : null,
    };
  },
});
