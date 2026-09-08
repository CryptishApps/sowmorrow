import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentRegistry } from "../lib/contracts/manifests";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const encoder = new TextEncoder();
const secret = "whsec_convex_test";
const vault = "0x1000000000000000000000000000000000000001";
const owner = "0x2000000000000000000000000000000000000002";
const checkedMainnetManifest = deploymentRegistry[8453]!;
const timestamp = Math.floor(Date.now() / 1_000);
const flatBody = JSON.stringify({
  block_number: 100,
  contract_address: vault,
  event_name: "GiftCreated",
  log_index: 4,
  network: "base-mainnet",
  transaction_hash: `0x${"b".repeat(64)}`,
});
const envelopeBody = JSON.stringify({
  id: "evt_body_id",
  type: "onchain.activity.detected",
  createdAt: "2026-09-03T00:00:00Z",
  data: {
    subscriptionId: "sub_test",
    networkId: "base-mainnet",
    blockNumber: 100,
    transactionHash: `0x${"b".repeat(64)}`,
    logIndex: 4,
    contractAddress: vault,
    eventName: "GiftCreated",
  },
});

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(bodyBytes: Uint8Array, variant: "current" | "legacy" = "current") {
  const headerNames =
    variant === "current" ? "content-type x-event-id x-event-type" : "content-type x-hook0-id";
  const headerValues =
    variant === "current"
      ? "application/json.evt_http_test.onchain.activity.detected"
      : "application/json.evt_http_test";
  const prefix = encoder.encode(`${timestamp}.${headerNames}.${headerValues}.`);
  const payload = new Uint8Array(prefix.length + bodyBytes.length);
  payload.set(prefix, 0);
  payload.set(bodyBytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `t=${timestamp},v0=${"0".repeat(64)},h=${headerNames},v1=${toHex(await crypto.subtle.sign("HMAC", key, payload))}`;
}

function post(
  t: ReturnType<typeof convexTest>,
  bodyBytes: Uint8Array,
  headers: Record<string, string>,
  declaredLength?: string,
) {
  return t.fetch("/webhooks/cdp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": declaredLength ?? String(bodyBytes.byteLength),
      ...headers,
    },
    body: bodyBytes as BodyInit,
  });
}

describe("CDP webhook HTTP route", () => {
  beforeEach(() => {
    process.env.SOWMORROW_CDP_WEBHOOK_SECRET = secret;
    process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID = "8453";
    deploymentRegistry[8453] = {
      ...checkedMainnetManifest,
      status: "active",
      vaultAddress: vault,
      deploymentBlock: 1,
      runtimeBytecodeHash: `0x${"1".repeat(64)}`,
      owner: { kind: "safe", address: owner },
    };
  });

  afterEach(() => {
    delete process.env.SOWMORROW_CDP_WEBHOOK_SECRET;
    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    deploymentRegistry[8453] = checkedMainnetManifest;
  });

  it("rejects an unauthenticated body without recording it", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, encoder.encode(envelopeBody), {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
    });
    expect(response.status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(0);
  });

  it("acknowledges and queues the current signed event envelope", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(envelopeBody);
    const response = await post(t, bytes, {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
      "x-hook0-signature": await signature(bytes),
    });
    expect(response.status).toBe(200);
    const deliveries = await t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ deliveryId: "evt_http_test", processingStatus: "pending" });
  });

  it("accepts the documented flat onchain payload with the legacy signed id header", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(flatBody);
    const response = await post(t, bytes, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(bytes, "legacy"),
    });
    expect(response.status).toBe(200);
    const deliveries = await t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
    expect(deliveries).toHaveLength(1);
  });

  it.each(["flat", "envelope"])("ignores signed non-gift vault events in the %s payload", async (format) => {
    const t = convexTest(schema, modules);
    const payload = JSON.parse(format === "flat" ? flatBody : envelopeBody);
    if (format === "flat") payload.event_name = "CreationPausedSet";
    else payload.data.eventName = "CreationPausedSet";
    const bytes = encoder.encode(JSON.stringify(payload));
    const headers = {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
    };
    expect((await post(t, bytes, headers)).status).toBe(401);
    const response = await post(t, bytes, {
      ...headers,
      "x-hook0-signature": await signature(bytes),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Event ignored");
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(0);

    if (format === "flat") payload.contract_address = owner;
    else payload.data.contractAddress = owner;
    const wrongVaultBytes = encoder.encode(JSON.stringify(payload));
    expect(
      (
        await post(t, wrongVaultBytes, {
          ...headers,
          "x-hook0-signature": await signature(wrongVaultBytes),
        })
      ).status,
    ).toBe(400);
  });

  it("rejects a request that declares no content length", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(envelopeBody);
    const response = await t.fetch("/webhooks/cdp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-id": "evt_http_test",
        "x-event-type": "onchain.activity.detected",
        "x-hook0-signature": await signature(bytes),
      },
      body: bytes as BodyInit,
    });
    expect(response.status).toBe(411);
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(0);
  });

  it.each([
    ["a non-numeric content length", "not-a-number", 400],
    ["a negative content length", "-1", 400],
    ["a non-canonical content length", "0012", 400],
    ["an over-cap declared content length", String(128 * 1024 + 1), 413],
  ])("rejects %s", async (_label, declared, status) => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(envelopeBody);
    const response = await post(
      t,
      bytes,
      {
        "x-event-id": "evt_http_test",
        "x-event-type": "onchain.activity.detected",
        "x-hook0-signature": await signature(bytes),
      },
      declared,
    );
    expect(response.status).toBe(status);
  });

  it("rejects a body whose real size disagrees with the declared length", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(envelopeBody);
    const response = await post(
      t,
      bytes,
      {
        "x-event-id": "evt_http_test",
        "x-event-type": "onchain.activity.detected",
        "x-hook0-signature": await signature(bytes),
      },
      String(bytes.byteLength - 1),
    );
    expect(response.status).toBe(400);
  });

  it("caps the received bytes even when the declared length understates them", async () => {
    const t = convexTest(schema, modules);
    const oversized = encoder.encode(`{"padding":"${"x".repeat(128 * 1024)}"}`);
    const response = await post(
      t,
      oversized,
      { "x-event-id": "evt_http_test", "x-event-type": "onchain.activity.detected" },
      "10",
    );
    expect(response.status).toBe(413);
  });

  it("rejects a body that is not valid UTF-8", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, new Uint8Array([0xff, 0xfe, 0xfd]), {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
    });
    expect(response.status).toBe(400);
  });

  it("verifies a leading byte order mark exactly as sent and still parses the payload", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(`﻿${envelopeBody}`);
    const response = await post(t, bytes, {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
      "x-hook0-signature": await signature(bytes),
    });
    expect(response.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
  });

  it("rejects a signature computed over the body without its byte order mark", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(`﻿${envelopeBody}`);
    const response = await post(t, bytes, {
      "x-event-id": "evt_http_test",
      "x-event-type": "onchain.activity.detected",
      "x-hook0-signature": await signature(encoder.encode(envelopeBody)),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a payload that targets another deployment", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(
      JSON.stringify({
        block_number: 100,
        contract_address: "0x9999999999999999999999999999999999999999",
        event_name: "GiftCreated",
        log_index: 4,
        network: "base-mainnet",
        transaction_hash: `0x${"b".repeat(64)}`,
      }),
    );
    const response = await post(t, bytes, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(bytes, "legacy"),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an authenticated body that is not a recognized event shape", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode('{"unexpected":true}');
    const response = await post(t, bytes, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(bytes, "legacy"),
    });
    expect(response.status).toBe(400);
  });

  it("reports a delivery id conflict when the same id carries a different body", async () => {
    const t = convexTest(schema, modules);
    const first = encoder.encode(flatBody);
    await post(t, first, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(first, "legacy"),
    });
    const second = encoder.encode(
      JSON.stringify({
        block_number: 101,
        contract_address: vault,
        event_name: "GiftCreated",
        log_index: 4,
        network: "base-mainnet",
        transaction_hash: `0x${"b".repeat(64)}`,
      }),
    );
    const response = await post(t, second, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(second, "legacy"),
    });
    expect(response.status).toBe(409);
  });

  it("deduplicates a replayed body that arrives under a new delivery id", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(flatBody);
    await post(t, bytes, {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(bytes, "legacy"),
    });

    const headerNames = "content-type x-hook0-id";
    const prefix = encoder.encode(`${timestamp}.${headerNames}.application/json.evt_replayed_id.`);
    const payload = new Uint8Array(prefix.length + bytes.length);
    payload.set(prefix, 0);
    payload.set(bytes, prefix.length);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const replaySignature = `t=${timestamp},h=${headerNames},v1=${toHex(await crypto.subtle.sign("HMAC", key, payload))}`;

    const response = await post(t, bytes, {
      "x-hook0-id": "evt_replayed_id",
      "x-hook0-signature": replaySignature,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Already accepted");
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").collect())).toHaveLength(1);
  });

  it("acknowledges a retried delivery that already reached a terminal state", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(flatBody);
    const headers = {
      "x-hook0-id": "evt_http_test",
      "x-hook0-signature": await signature(bytes, "legacy"),
    };
    await post(t, bytes, headers);
    await t.run(async (ctx) => {
      const delivery = await ctx.db.query("webhookDeliveries").unique();
      await ctx.db.patch(delivery!._id, { processingStatus: "applied" });
    });

    const response = await post(t, bytes, headers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Already accepted");
  });

  it("reports an unconfigured webhook without a secret or an active manifest", async () => {
    const t = convexTest(schema, modules);
    const bytes = encoder.encode(flatBody);
    delete process.env.SOWMORROW_CDP_WEBHOOK_SECRET;
    await expect(post(t, bytes, { "x-hook0-id": "evt_http_test" })).resolves.toMatchObject({ status: 503 });

    process.env.SOWMORROW_CDP_WEBHOOK_SECRET = secret;
    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    await expect(post(t, bytes, { "x-hook0-id": "evt_http_test" })).resolves.toMatchObject({ status: 503 });
  });
});
