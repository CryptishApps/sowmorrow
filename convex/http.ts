import { httpRouter } from "convex/server";
import { z } from "zod";
import { getAddress, isAddress, isHash } from "viem";
import { authenticateCdpWebhookSignature } from "../lib/webhooks/cdp";
import { activeManifestFromEnvironment } from "../lib/contracts/manifests";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const MAX_WEBHOOK_BYTES = 128 * 1024;
const flatWebhookEventSchema = z
  .object({
    block_number: z.number().int().nonnegative().safe(),
    contract_address: z.string().refine((value) => isAddress(value)),
    event_name: z.string().min(1).max(256),
    log_index: z.number().int().nonnegative().safe(),
    network: z.enum(["base-mainnet", "base-sepolia"]),
    transaction_hash: z.string().refine((value) => isHash(value)),
  })
  .passthrough();

const envelopedWebhookEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("onchain.activity.detected"),
    data: z
      .object({
        blockNumber: z.number().int().nonnegative().safe(),
        contractAddress: z.string().refine((value) => isAddress(value)),
        eventName: z.string().min(1).max(256),
        logIndex: z.number().int().nonnegative().safe(),
        networkId: z.enum(["base-mainnet", "base-sepolia"]),
        transactionHash: z.string().refine((value) => isHash(value)),
      })
      .passthrough(),
  })
  .passthrough();

function parseWebhookEvent(payload: unknown): z.infer<typeof flatWebhookEventSchema> {
  const envelope = envelopedWebhookEventSchema.safeParse(payload);
  if (envelope.success) {
    return {
      block_number: envelope.data.data.blockNumber,
      contract_address: envelope.data.data.contractAddress,
      event_name: envelope.data.data.eventName,
      log_index: envelope.data.data.logIndex,
      network: envelope.data.data.networkId,
      transaction_hash: envelope.data.data.transactionHash,
    };
  }
  return flatWebhookEventSchema.parse(payload);
}

function response(status: number, message: string) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function sha256Hex(value: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const http = httpRouter();

http.route({
  path: "/webhooks/cdp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.SOWMORROW_CDP_WEBHOOK_SECRET;
    let manifest;
    try {
      manifest = activeManifestFromEnvironment({
        SOWMORROW_DEPLOYMENT_CHAIN_ID: process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID,
      });
    } catch {
      return response(503, "Webhook is not configured");
    }
    if (!secret) return response(503, "Webhook is not configured");

    const declaredLength = request.headers.get("content-length");
    if (declaredLength === null) return response(411, "Content-Length is required");
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || String(length) !== declaredLength.trim()) {
      return response(400, "Invalid content length");
    }
    if (length > MAX_WEBHOOK_BYTES) return response(413, "Webhook body is too large");

    const rawBytes = new Uint8Array(await request.arrayBuffer());
    if (rawBytes.byteLength > MAX_WEBHOOK_BYTES) return response(413, "Webhook body is too large");
    if (rawBytes.byteLength !== length) return response(400, "Content length does not match the body");
    let rawBody: string;
    try {
      rawBody = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch {
      return response(400, "Webhook body must be UTF-8");
    }

    const authentication = await authenticateCdpWebhookSignature({
      rawBody: rawBytes,
      signatureHeader: request.headers.get("x-hook0-signature"),
      secret,
      headers: request.headers,
    });
    if (!authentication) return response(401, "Invalid webhook signature");

    let payload: z.infer<typeof flatWebhookEventSchema>;
    try {
      payload = parseWebhookEvent(JSON.parse(rawBody));
    } catch {
      return response(400, "Invalid webhook payload");
    }

    const vaultAddressLower = getAddress(payload.contract_address).toLowerCase();
    if (payload.network !== manifest.network || vaultAddressLower !== manifest.vaultAddress.toLowerCase()) {
      return response(400, "Webhook target does not match this deployment");
    }

    if (payload.event_name !== "GiftCreated" && payload.event_name !== "GiftClaimed") {
      return response(200, "Event ignored");
    }

    const receipt = await ctx.runMutation(internal.webhooks.recordVerifiedDelivery, {
      deliveryId: authentication.deliveryId,
      bodyHash: await sha256Hex(rawBytes),
      receivedAt: Math.floor(Date.now() / 1_000),
      chainId: manifest.chainId,
      vaultAddressLower,
      transactionHashLower: payload.transaction_hash.toLowerCase(),
      logIndex: payload.log_index,
      blockNumber: payload.block_number,
      eventName: payload.event_name,
    });

    if (receipt.operation === "conflict") return response(409, "Delivery id conflict");
    if (receipt.operation === "duplicate_body") return response(200, "Already accepted");
    if (
      receipt.operation === "duplicate" &&
      (receipt.processingStatus === "applied" ||
        receipt.processingStatus === "duplicate" ||
        receipt.processingStatus === "failed")
    ) {
      return response(200, "Already accepted");
    }

    await ctx.scheduler.runAfter(0, internal.reconciliation.reconcileDelivery, {
      deliveryId: authentication.deliveryId,
    });
    return response(200, receipt.operation === "duplicate" ? "Retry accepted" : "Accepted");
  }),
});

export default http;
