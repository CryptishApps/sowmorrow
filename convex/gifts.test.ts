import { keccak256, stringToBytes } from "viem";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentRegistry } from "../lib/contracts/manifests";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const applyCanonicalVaultLog = makeFunctionReference<"mutation">("events:applyCanonicalVaultLog");
const initializeCursor = makeFunctionReference<"mutation">("indexer:initializeCursor");
const advanceCursor = makeFunctionReference<"mutation">("indexer:advanceCursor");
const recordSyncRun = makeFunctionReference<"mutation">("observability:recordSyncRun");
const recentSyncRuns = makeFunctionReference<"query">("observability:recentSyncRuns");
const forRecipient = makeFunctionReference<"query">("gifts:forRecipient");
const detail = makeFunctionReference<"query">("gifts:detail");
const freshness = makeFunctionReference<"query">("gifts:freshness");

const VAULT = "0x1000000000000000000000000000000000000001";
const VAULT_LOWER = VAULT.toLowerCase();
const OWNER = "0x2000000000000000000000000000000000000002";
const RECIPIENT = "0x3000000000000000000000000000000000000003";
const SENDER = "0x4000000000000000000000000000000000000004";
const STOCK = "0x5000000000000000000000000000000000000005";
const checkedMainnetManifest = deploymentRegistry[8453]!;

function created(index: number) {
  return {
    chainId: 8453,
    vaultAddressLower: VAULT_LOWER,
    transactionHashLower: `0x${index.toString(16).padStart(64, "0")}`,
    transactionIndex: 0,
    logIndex: 0,
    blockNumber: 100 + index,
    blockHashLower: `0x${(1_000 + index).toString(16).padStart(64, "0")}`,
    eventName: "GiftCreated" as const,
    giftIdDecimal: String(index),
    senderLower: SENDER.toLowerCase(),
    recipientLower: RECIPIENT.toLowerCase(),
    stockLower: STOCK.toLowerCase(),
    amountRawDecimal: "1000",
    unlockAt: 1_900_000_000 + index,
    noteHashLower: keccak256(stringToBytes("grow slowly")),
    canonicality: "safe" as const,
    source: "reconciler" as const,
    observedAt: 1_800_000_000,
  };
}

beforeEach(() => {
  deploymentRegistry[8453] = {
    ...checkedMainnetManifest,
    status: "active",
    vaultAddress: VAULT,
    deploymentBlock: 1,
    runtimeBytecodeHash: `0x${"1".repeat(64)}`,
    owner: { kind: "safe", address: OWNER },
  };
});

afterEach(() => {
  deploymentRegistry[8453] = checkedMainnetManifest;
});

describe("recipient gift pagination", () => {
  it("crosses three bounded pages and clamps an unbounded page request", async () => {
    const t = convexTest(schema, modules);
    for (let index = 1; index <= 7; index += 1) {
      await t.mutation(applyCanonicalVaultLog, created(index));
    }

    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result: {
        page: Array<{ giftIdDecimal: string }>;
        continueCursor: string;
        isDone: boolean;
      } = await t.query(forRecipient, {
        chainId: 8453,
        recipientLower: RECIPIENT.toLowerCase(),
        paginationOpts: { numItems: 3, cursor },
      });
      seen.push(...result.page.map((gift) => gift.giftIdDecimal));
      cursor = result.continueCursor;
      if (result.isDone) break;
    }
    expect(seen).toEqual(["7", "6", "5", "4", "3", "2", "1"]);

    const clamped = await t.query(forRecipient, {
      chainId: 8453,
      recipientLower: RECIPIENT.toLowerCase(),
      paginationOpts: { numItems: 5_000, cursor: null },
    });
    expect(clamped.page).toHaveLength(7);
  });

  it("rejects an unchecked chain id and a non-normalized recipient", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(forRecipient, {
        chainId: 1,
        recipientLower: RECIPIENT.toLowerCase(),
        paginationOpts: { numItems: 3, cursor: null },
      }),
    ).rejects.toThrow();
    await expect(
      t.query(forRecipient, {
        chainId: 8453,
        recipientLower: RECIPIENT.toUpperCase(),
        paginationOpts: { numItems: 3, cursor: null },
      }),
    ).rejects.toThrow();
  });

  it("falls back to the page ceiling for a non-integer page size", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created(1));
    const result = await t.query(forRecipient, {
      chainId: 8453,
      recipientLower: RECIPIENT.toLowerCase(),
      paginationOpts: { numItems: Number.NaN, cursor: null },
    });
    expect(result.page).toHaveLength(1);
  });
});

describe("gift detail", () => {
  it("returns the projection with its verified note or null when unknown", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created(1));
    await t.run(async (ctx) => {
      await ctx.db.insert("noteAttachments", {
        chainId: 8453,
        vaultAddressLower: VAULT_LOWER,
        giftIdDecimal: "1",
        noteUtf8: "grow slowly",
        noteHashLower: keccak256(stringToBytes("grow slowly")),
        byteLength: 11,
        createdTxHashLower: `0x${"1".padStart(64, "0")}`,
        createdLogIndex: 0,
        verifiedSenderLower: SENDER.toLowerCase(),
        verifiedAt: 1_800_000_100,
      });
    });

    await expect(t.query(detail, { chainId: 8453, vault: VAULT, giftId: "1" })).resolves.toMatchObject({
      gift: { giftIdDecimal: "1", state: "active" },
      note: { noteUtf8: "grow slowly" },
    });
    await expect(t.query(detail, { chainId: 8453, vault: VAULT, giftId: "2" })).resolves.toBeNull();
  });

  it("returns a gift without a note as an explicit null note", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created(1));
    await expect(t.query(detail, { chainId: 8453, vault: VAULT, giftId: "1" })).resolves.toMatchObject({
      note: null,
    });
  });

  it("rejects a vault that is not the active manifest vault", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(detail, { chainId: 8453, vault: OWNER, giftId: "1" })).rejects.toThrow();
  });
});

describe("index freshness", () => {
  it("reports an empty index before any cursor or sync run exists", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(freshness, { chainId: 8453 })).resolves.toEqual({
      chainId: 8453,
      safeHeadBlock: null,
      cursor: null,
      lagBlocks: null,
      lastSyncRun: null,
    });
  });

  it("reports the safe head, cursor, and last run once the reconciler has run", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(initializeCursor, {
      pipeline: "vault-events",
      chainId: 8453,
      contractAddressLower: VAULT_LOWER,
      deploymentBlock: 100,
      now: 1_800_000_000,
    });
    await t.mutation(advanceCursor, {
      pipeline: "vault-events",
      chainId: 8453,
      contractAddressLower: VAULT_LOWER,
      expectedNextBlock: 100,
      committedBlock: 900,
      committedBlockHashLower: `0x${"3".repeat(64)}`,
      now: 1_800_000_001,
    });
    await t.mutation(recordSyncRun, {
      pipeline: "vault-events",
      chainId: 8453,
      contractAddressLower: VAULT_LOWER,
      startedAt: 1_800_000_000,
      endedAt: 1_800_000_002,
      fromBlock: 100,
      toBlock: 900,
      safeHeadBlock: 1_000,
      eventsApplied: 3,
      outcome: "indexed",
    });

    await expect(t.query(freshness, { chainId: 8453 })).resolves.toMatchObject({
      safeHeadBlock: 1_000,
      lagBlocks: 100,
      cursor: { nextBlock: 901, lastCommittedBlock: 900, state: "active", failureCode: null },
      lastSyncRun: { outcome: "indexed", eventsApplied: 3, errorCode: null },
    });
    expect(await t.query(recentSyncRuns, { chainId: 8453, limit: 1_000 })).toHaveLength(1);
    expect(await t.query(recentSyncRuns, { chainId: 84532, limit: 10 })).toHaveLength(0);
  });

  it("rejects an unchecked chain id", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(freshness, { chainId: 1 })).rejects.toThrow();
  });
});
