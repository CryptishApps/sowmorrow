import { ConvexError, v } from "convex/values";
import { keccak256, stringToBytes } from "viem";
import { mutation, query } from "./_generated/server";
import { MAX_NOTE_BYTES, assertGiftId, assertManifestChainId, assertManifestVault } from "./bounds";

const utf8 = new TextEncoder();

const giftKeyArgs = {
  chainId: v.number(),
  vault: v.string(),
  giftId: v.string(),
};

function boundedGiftKey(chainId: number, vault: string, giftId: string) {
  return {
    chainId: assertManifestChainId(chainId),
    vaultAddressLower: assertManifestVault(chainId, vault),
    giftIdDecimal: assertGiftId(giftId),
  };
}

export const attachNote = mutation({
  args: { ...giftKeyArgs, note: v.string() },
  handler: async (ctx, { chainId, vault, giftId, note }) => {
    const key = boundedGiftKey(chainId, vault, giftId);
    const byteLength = utf8.encode(note).length;
    if (byteLength === 0 || byteLength > MAX_NOTE_BYTES) {
      throw new ConvexError({ code: "INVALID_NOTE_LENGTH" });
    }

    const gift = await ctx.db
      .query("gifts")
      .withIndex("by_gift_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", key.chainId)
          .eq("vaultAddressLower", key.vaultAddressLower)
          .eq("giftIdDecimal", key.giftIdDecimal),
      )
      .unique();
    if (!gift) throw new ConvexError({ code: "UNKNOWN_GIFT" });

    const noteHashLower = keccak256(stringToBytes(note)).toLowerCase();
    if (noteHashLower !== gift.noteHashLower) throw new ConvexError({ code: "NOTE_HASH_MISMATCH" });

    const existing = await ctx.db
      .query("noteAttachments")
      .withIndex("by_gift_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", key.chainId)
          .eq("vaultAddressLower", key.vaultAddressLower)
          .eq("giftIdDecimal", key.giftIdDecimal),
      )
      .unique();
    if (existing) {
      if (existing.noteHashLower !== noteHashLower) throw new ConvexError({ code: "NOTE_HASH_MISMATCH" });
      return { operation: "unchanged" as const };
    }

    await ctx.db.insert("noteAttachments", {
      ...key,
      noteUtf8: note,
      noteHashLower,
      byteLength,
      createdTxHashLower: gift.createdTxHashLower,
      createdLogIndex: gift.createdLogIndex,
      verifiedSenderLower: gift.senderLower,
      verifiedAt: Math.floor(Date.now() / 1_000),
    });
    return { operation: "attached" as const };
  },
});

export const noteForGift = query({
  args: giftKeyArgs,
  handler: async (ctx, { chainId, vault, giftId }) => {
    const key = boundedGiftKey(chainId, vault, giftId);
    const attachment = await ctx.db
      .query("noteAttachments")
      .withIndex("by_gift_key", (queryBuilder) =>
        queryBuilder
          .eq("chainId", key.chainId)
          .eq("vaultAddressLower", key.vaultAddressLower)
          .eq("giftIdDecimal", key.giftIdDecimal),
      )
      .unique();
    if (!attachment) return null;
    return {
      noteUtf8: attachment.noteUtf8,
      noteHashLower: attachment.noteHashLower,
      byteLength: attachment.byteLength,
      verifiedSenderLower: attachment.verifiedSenderLower,
      verifiedAt: attachment.verifiedAt,
    };
  },
});
