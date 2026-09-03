import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { keccak256, stringToBytes } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentRegistry } from "../lib/contracts/manifests";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const applyCanonicalVaultLog = makeFunctionReference<"mutation">("events:applyCanonicalVaultLog");
const attachNote = makeFunctionReference<"mutation">("notes:attachNote");
const noteForGift = makeFunctionReference<"query">("notes:noteForGift");

const VAULT = "0x1000000000000000000000000000000000000001";
const OWNER = "0x2000000000000000000000000000000000000002";
const RECIPIENT = "0x3000000000000000000000000000000000000003";
const SENDER = "0x4000000000000000000000000000000000000004";
const STOCK = "0x5000000000000000000000000000000000000005";
const NOTE = "Happy eighteenth birthday. Sell nothing before you are thirty.";
const NOTE_HASH = keccak256(stringToBytes(NOTE));
const checkedMainnetManifest = deploymentRegistry[8453]!;

function created(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    vaultAddressLower: VAULT.toLowerCase(),
    transactionHashLower: `0x${"1".repeat(64)}`,
    transactionIndex: 0,
    logIndex: 0,
    blockNumber: 100,
    blockHashLower: `0x${"2".repeat(64)}`,
    eventName: "GiftCreated",
    giftIdDecimal: "1",
    senderLower: SENDER.toLowerCase(),
    recipientLower: RECIPIENT.toLowerCase(),
    stockLower: STOCK.toLowerCase(),
    amountRawDecimal: "1000",
    unlockAt: 1_900_000_000,
    noteHashLower: NOTE_HASH.toLowerCase(),
    canonicality: "safe",
    source: "reconciler",
    observedAt: 1_800_000_000,
    ...overrides,
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

describe("verified note attachments", () => {
  it("accepts a note whose keccak hash matches the projected gift", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: NOTE }),
    ).resolves.toEqual({ operation: "attached" });

    expect(await t.query(noteForGift, { chainId: 8453, vault: VAULT, giftId: "1" })).toMatchObject({
      noteUtf8: NOTE,
      noteHashLower: NOTE_HASH.toLowerCase(),
      byteLength: NOTE.length,
      verifiedSenderLower: SENDER.toLowerCase(),
    });
  });

  it("is idempotent on a repeated identical attachment", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: NOTE });

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: NOTE }),
    ).resolves.toEqual({ operation: "unchanged" });
    expect(await t.run((ctx) => ctx.db.query("noteAttachments").collect())).toHaveLength(1);
  });

  it("rejects a note whose hash does not match the gift", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: `${NOTE} ` }),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("noteAttachments").collect())).toHaveLength(0);
  });

  it("refuses to replace an attached note with a different one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, created());
    await t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: NOTE });
    await t.run(async (ctx) => {
      const gift = await ctx.db.query("gifts").unique();
      await ctx.db.patch(gift!._id, { noteHashLower: keccak256(stringToBytes("other")).toLowerCase() });
    });

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: "other" }),
    ).rejects.toThrow();
  });

  it("rejects an empty note and a note over two hundred and eighty UTF-8 bytes", async () => {
    const t = convexTest(schema, modules);
    const long = "é".repeat(141);
    await t.mutation(
      applyCanonicalVaultLog,
      created({ noteHashLower: keccak256(stringToBytes(long)).toLowerCase() }),
    );

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: "" }),
    ).rejects.toThrow();
    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: long }),
    ).rejects.toThrow();
  });

  it("accepts exactly two hundred and eighty UTF-8 bytes", async () => {
    const t = convexTest(schema, modules);
    const exact = "é".repeat(140);
    await t.mutation(
      applyCanonicalVaultLog,
      created({ noteHashLower: keccak256(stringToBytes(exact)).toLowerCase() }),
    );

    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: exact }),
    ).resolves.toEqual({ operation: "attached" });
    expect(await t.run((ctx) => ctx.db.query("noteAttachments").unique())).toMatchObject({
      byteLength: 280,
    });
  });

  it("rejects a gift that is not in the canonical projection", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(attachNote, { chainId: 8453, vault: VAULT, giftId: "1", note: NOTE }),
    ).rejects.toThrow();
    expect(await t.query(noteForGift, { chainId: 8453, vault: VAULT, giftId: "1" })).toBeNull();
  });

  it.each([
    ["an unknown chain id", { chainId: 1, vault: VAULT, giftId: "1" }],
    ["a vault outside the manifest", { chainId: 8453, vault: OWNER, giftId: "1" }],
    ["a lowercase vault address", { chainId: 8453, vault: VAULT.toUpperCase(), giftId: "1" }],
    ["a zero gift id", { chainId: 8453, vault: VAULT, giftId: "0" }],
    ["a non-canonical gift id", { chainId: 8453, vault: VAULT, giftId: "01" }],
    ["a non-numeric gift id", { chainId: 8453, vault: VAULT, giftId: "one" }],
    ["a negative gift id", { chainId: 8453, vault: VAULT, giftId: "-1" }],
  ])("rejects %s on both the mutation and the query", async (_label, key) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(attachNote, { ...key, note: NOTE })).rejects.toThrow();
    await expect(t.query(noteForGift, key)).rejects.toThrow();
  });

  it("rejects a chain whose manifest carries no vault yet", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(noteForGift, { chainId: 84532, vault: VAULT, giftId: "1" })).rejects.toThrow();
  });
});
