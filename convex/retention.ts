import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { retentionSeconds } from "./deployment";

const MAX_PRUNE_BATCH = 200;

const terminalDeliveryStatuses: ReadonlyArray<Doc<"webhookDeliveries">["processingStatus"]> = [
  "applied",
  "duplicate",
  "failed",
];

export const pruneTerminalRecords = internalMutation({
  args: { now: v.optional(v.number()), retainSeconds: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Math.floor(Date.now() / 1_000);
    const retain = args.retainSeconds ?? retentionSeconds();
    const limit = Math.min(Math.max(Math.floor(args.limit ?? MAX_PRUNE_BATCH), 1), MAX_PRUNE_BATCH);
    const cutoff = now - retain;

    const deliveries = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_received", (queryBuilder) => queryBuilder.lt("receivedAt", cutoff))
      .order("asc")
      .take(limit);
    let deliveriesDeleted = 0;
    for (const delivery of deliveries) {
      if (!terminalDeliveryStatuses.includes(delivery.processingStatus)) continue;
      await ctx.db.delete(delivery._id);
      deliveriesDeleted += 1;
    }

    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_ended", (queryBuilder) => queryBuilder.lt("endedAt", cutoff))
      .order("asc")
      .take(limit);
    for (const run of runs) await ctx.db.delete(run._id);

    return { cutoff, deliveriesDeleted, syncRunsDeleted: runs.length };
  },
});
