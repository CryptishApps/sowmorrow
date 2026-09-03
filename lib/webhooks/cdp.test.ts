import { describe, expect, it, vi } from "vitest";
import { verifyCdpWebhookSignature } from "./cdp";

const encoder = new TextEncoder();
const secret = "whsec_test_only";
const timestamp = 1_800_000_000;
const body = '{"transaction_hash":"0x123","log_index":4}';
const bodyBytes = encoder.encode(body);

function currentHeaders() {
  return new Headers({
    "content-type": "application/json",
    "x-event-id": "evt_123",
    "x-event-type": "onchain.activity.detected",
  });
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signatureFor({
  signedHeaders = "content-type x-event-id x-event-type",
  signedBody = bodyBytes,
  signedTimestamp = timestamp,
  headers = new Headers({
    "content-type": "application/json",
    "x-event-id": "evt_123",
    "x-event-type": "onchain.activity.detected",
  }),
} = {}) {
  const headerValues = signedHeaders
    .split(" ")
    .map((name) => headers.get(name) ?? "")
    .join(".");
  const prefix = encoder.encode(`${signedTimestamp}.${signedHeaders}.${headerValues}.`);
  const payload = new Uint8Array(prefix.length + signedBody.length);
  payload.set(prefix, 0);
  payload.set(signedBody, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return `t=${signedTimestamp},v0=${"0".repeat(64)},h=${signedHeaders},v1=${toHex(signature)}`;
}

describe("verifyCdpWebhookSignature", () => {
  it("accepts an authentic signature over the untouched body and delivery headers", async () => {
    const headers = currentHeaders();

    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers }),
        secret,
        headers,
        nowSeconds: timestamp + 30,
      }),
    ).resolves.toBe(true);
  });

  it("also accepts Coinbase's earlier signed X-Hook0-Id variant", async () => {
    const headers = new Headers({ "content-type": "application/json", "x-hook0-id": "evt_123" });
    const signedHeaders = "content-type x-hook0-id";
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers, signedHeaders }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a body changed after signing", async () => {
    const headers = currentHeaders();

    await expect(
      verifyCdpWebhookSignature({
        rawBody: encoder.encode(`${body} `),
        signatureHeader: await signatureFor({ headers }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["stale", timestamp + 301],
    ["too far in the future", timestamp - 301],
  ])("rejects a %s delivery timestamp", async (_label, nowSeconds) => {
    const headers = currentHeaders();

    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers }),
        secret,
        headers,
        nowSeconds,
      }),
    ).resolves.toBe(false);
  });

  it("requires the delivery id and content type to be covered by the signature", async () => {
    const headers = currentHeaders();
    const signedHeaders = "content-type";

    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers, signedHeaders }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a different signed event type on the current header scheme", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-event-id": "evt_123",
      "x-event-type": "wallet.activity.detected",
    });
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    null,
    "",
    "t=bad,h=content-type x-hook0-id,v1=not-hex",
    "t=1800000000,t=1800000000,h=content-type x-hook0-id,v1=00",
  ])("rejects a malformed signature header: %s", async (signatureHeader) => {
    const headers = currentHeaders();
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader,
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });
  it("verifies a leading UTF-8 byte order mark exactly as it was sent", async () => {
    const headers = currentHeaders();
    const withBom = encoder.encode(`\uFEFF${body}`);

    await expect(
      verifyCdpWebhookSignature({
        rawBody: withBom,
        signatureHeader: await signatureFor({ headers, signedBody: withBom }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers, signedBody: withBom }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an empty secret, an unusable clock, and a non-positive freshness window", async () => {
    const headers = currentHeaders();
    const signatureHeader = await signatureFor({ headers });

    await expect(
      verifyCdpWebhookSignature({ rawBody: bodyBytes, signatureHeader, secret: "", headers }),
    ).resolves.toBe(false);
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader,
        secret,
        headers,
        nowSeconds: Number.NaN,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader,
        secret,
        headers,
        nowSeconds: timestamp,
        maxAgeSeconds: 0,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["a duplicated signed header list", "t=1800000000,h=content-type x-hook0-id,h=content-type,v1=00"],
    [
      "a duplicated signature",
      `t=1800000000,h=content-type x-hook0-id,v1=${"0".repeat(64)},v1=${"1".repeat(64)}`,
    ],
    ["a non-canonical timestamp", "t=01800000000,h=content-type x-hook0-id,v1=00"],
    ["an empty field value", "t=,h=content-type x-hook0-id,v1=00"],
    ["a field without a name", "=1800000000,h=content-type x-hook0-id,v1=00"],
    ["a missing signature field", "t=1800000000,h=content-type x-hook0-id"],
    ["an uppercase signed header name", `t=${timestamp},h=Content-Type x-hook0-id,v1=${"0".repeat(64)}`],
    [
      "a repeated signed header name",
      `t=${timestamp},h=content-type content-type x-hook0-id,v1=${"0".repeat(64)}`,
    ],
    ["a signed list without a delivery id header", `t=${timestamp},h=content-type,v1=${"0".repeat(64)}`],
    ["a signature that is not full-length hex", `t=${timestamp},h=content-type x-hook0-id,v1=abcd`],
    ["a signature with non-hex characters", `t=${timestamp},h=content-type x-hook0-id,v1=${"z".repeat(64)}`],
  ])("rejects %s", async (_label, signatureHeader) => {
    const headers = new Headers({ "content-type": "application/json", "x-hook0-id": "evt_123" });
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader,
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a signed header that the request does not carry", async () => {
    const headers = new Headers({ "content-type": "application/json", "x-hook0-id": "evt_123" });
    const signedHeaders = "content-type x-hook0-id x-absent-header";
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers, signedHeaders }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a signed delivery id header whose value is absent", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    const signedHeaders = "content-type x-hook0-id";
    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader: await signatureFor({ headers, signedHeaders }),
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
  });
  it("rejects the delivery when the platform crypto verify call fails", async () => {
    const headers = currentHeaders();
    const signatureHeader = await signatureFor({ headers });
    const verify = vi.spyOn(crypto.subtle, "verify").mockRejectedValueOnce(new Error("crypto unavailable"));

    await expect(
      verifyCdpWebhookSignature({
        rawBody: bodyBytes,
        signatureHeader,
        secret,
        headers,
        nowSeconds: timestamp,
      }),
    ).resolves.toBe(false);
    verify.mockRestore();
  });
});
