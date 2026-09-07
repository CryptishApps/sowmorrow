import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");
const deliver = makeFunctionReference<"action">("monitorAlerts:deliver");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("reports disabled delivery without configuration and rejects failed HTTP delivery", async () => {
  const t = convexTest(schema, modules);
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("SOWMORROW_MONITOR_WEBHOOK_URL", "");
  const args = {
    chainId: 84532,
    vault: "0x1111111111111111111111111111111111111111",
    observedAt: 1800000000,
    insolvent: 1,
    unreadable: 0,
    lagBlocks: 0,
  };
  expect(await t.action(deliver, args)).toEqual({ operation: "not_configured" });
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("SOWMORROW_MONITOR_WEBHOOK_URL", "https://alerts.example.test/events");
  await expect(t.action(deliver, args)).rejects.toThrow();
  fetch.mockResolvedValue({ ok: true, status: 204 });
  expect(await t.action(deliver, args)).toEqual({ operation: "delivered" });
});
