import { makeFunctionReference } from "convex/server";

export const mirrorUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
export const mirrorConfigured = mirrorUrl.length > 0;

export type MirrorGiftRow = {
  chainId: number;
  vaultAddressLower: string;
  giftIdDecimal: string;
  senderLower: string;
  recipientLower: string;
  stockLower: string;
  amountRawDecimal: string;
  unlockAt: number;
  noteHashLower: string;
  state: "active" | "claimed";
  createdBlock: number;
  lastChainVerifiedAt: number;
};

export type MirrorNote = {
  noteUtf8: string;
  noteHashLower: string;
};

export type MirrorFreshness = {
  chainId: number;
  safeHeadBlock: number | null;
  lagBlocks: number | null;
  cursor: { lastCommittedBlock: number | null; state: string } | null;
};

export type MirrorPage = {
  page: MirrorGiftRow[];
  isDone: boolean;
  continueCursor: string;
};

type GiftKeyArgs = { chainId: number; vault: string; giftId: string };

export const mirrorApi = {
  giftsForRecipient: makeFunctionReference<
    "query",
    {
      chainId: number;
      recipientLower: string;
      paginationOpts: { numItems: number; cursor: string | null };
    },
    MirrorPage
  >("gifts:forRecipient"),
  giftDetail: makeFunctionReference<
    "query",
    GiftKeyArgs,
    { gift: MirrorGiftRow; note: MirrorNote | null } | null
  >("gifts:detail"),
  freshness: makeFunctionReference<"query", { chainId: number }, MirrorFreshness>("gifts:freshness"),
  noteForGift: makeFunctionReference<"query", GiftKeyArgs, MirrorNote | null>("notes:noteForGift"),
  attachNote: makeFunctionReference<
    "mutation",
    GiftKeyArgs & { note: string },
    { operation: "attached" | "unchanged" }
  >("notes:attachNote"),
};
