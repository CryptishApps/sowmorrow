import { v } from "convex/values";
import { internalAction } from "./_generated/server";
export const deliver = internalAction({
  args: {
    chainId: v.number(),
    vault: v.string(),
    observedAt: v.number(),
    insolvent: v.number(),
    unreadable: v.number(),
    lagBlocks: v.number(),
  },
  handler: async (_ctx, summary) => {
    const endpoint = process.env.SOWMORROW_MONITOR_WEBHOOK_URL;
    if (!endpoint) return { operation: "not_configured" as const };
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Alert endpoint must use HTTPS without URL credentials");
    const secret = process.env.SOWMORROW_MONITOR_WEBHOOK_SECRET;
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ service: "sowmorrow", ...summary }),
    });
    if (!response.ok) throw new Error(`Monitor alert delivery failed (${response.status})`);
    return { operation: "delivered" as const };
  },
});
