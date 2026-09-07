import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { it, expect } from "vitest";
import { keccak256, stringToBytes } from "viem";
import schema from "./schema";
import { deploymentRegistry } from "../lib/contracts/manifests";
const modules = import.meta.glob("./**/*.ts");
const mutation = (name: string) => makeFunctionReference<"mutation">(name);
const query = (name: string) => makeFunctionReference<"query">(name);
const chainId = 84532;
const vault = deploymentRegistry[chainId]!.vaultAddress!;
const vaultAddressLower = vault.toLowerCase();
const sender = "0x1000000000000000000000000000000000000001";
const recipient = "0x2000000000000000000000000000000000000002";
const stock = "0x3000000000000000000000000000000000000003";
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
function created(id: number, block = 100, note = "original note") {
  return {
    chainId,
    vaultAddressLower,
    transactionHashLower: hash(id),
    transactionIndex: 0,
    logIndex: 0,
    blockNumber: block,
    blockHashLower: hash(block),
    eventName: "GiftCreated" as const,
    giftIdDecimal: String(id),
    senderLower: sender,
    recipientLower: recipient,
    stockLower: stock,
    amountRawDecimal: "100",
    unlockAt: 1900000000,
    noteHashLower: keccak256(stringToBytes(note)),
    canonicality: "safe" as const,
    source: "reconciler" as const,
    observedAt: 1800000000,
  };
}
it("reorg scanner must reach events behind 500 orphaned entries", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let i = 1; i <= 502; i++) {
      const { observedAt, source, ...e } = created(i, 100 + i);
      expect(source).toBe("reconciler");
      await ctx.db.insert("chainEvents", {
        ...e,
        canonicality: i === 1 ? "safe" : i === 2 ? "tip" : "orphaned",
        firstSeenAt: observedAt,
        lastVerifiedAt: observedAt,
        seenViaWebhook: false,
        seenViaReconciler: true,
      });
    }
  });
  const events = await t.query(query("events:listEventsAboveBlock"), {
    chainId,
    vaultAddressLower,
    aboveBlock: 100,
    limit: 500,
  });
  expect(events.map((event: { giftIdDecimal: string }) => event.giftIdDecimal)).toEqual(["2", "1"]);
});
it("orphaned note must not be returned for replacement gift", async () => {
  const t = convexTest(schema, modules);
  const original = created(1);
  await t.mutation(mutation("events:applyCanonicalVaultLog"), original);
  await t.mutation(mutation("notes:attachNote"), { chainId, vault, giftId: "1", note: "original note" });
  await t.mutation(mutation("events:setEventCanonicality"), {
    chainId,
    vaultAddressLower,
    transactionHashLower: original.transactionHashLower,
    logIndex: 0,
    blockHashLower: original.blockHashLower,
    canonicality: "orphaned",
    observedAt: 1800000001,
  });
  await t.mutation(mutation("events:applyCanonicalVaultLog"), {
    ...created(1, 101, "replacement note"),
    transactionHashLower: hash(999),
  });
  const detail = await t.query(query("gifts:detail"), { chainId, vault, giftId: "1" });
  expect(detail.note).toBeNull();
});
it("replacement gift must accept its own matching note", async () => {
  const t = convexTest(schema, modules);
  const original = created(1);
  await t.mutation(mutation("events:applyCanonicalVaultLog"), original);
  await t.mutation(mutation("notes:attachNote"), { chainId, vault, giftId: "1", note: "original note" });
  await t.mutation(mutation("events:setEventCanonicality"), {
    chainId,
    vaultAddressLower,
    transactionHashLower: original.transactionHashLower,
    logIndex: 0,
    blockHashLower: original.blockHashLower,
    canonicality: "orphaned",
    observedAt: 1800000001,
  });
  await t.mutation(mutation("events:applyCanonicalVaultLog"), {
    ...created(1, 101, "replacement note"),
    transactionHashLower: hash(999),
  });
  await expect(
    t.mutation(mutation("notes:attachNote"), { chainId, vault, giftId: "1", note: "replacement note" }),
  ).resolves.toEqual({ operation: "attached" });
});
