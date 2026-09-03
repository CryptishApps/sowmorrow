const encoder = new TextEncoder();
const SHA256_HEX_LENGTH = 64;

type VerificationInput = {
  rawBody: Uint8Array;
  signatureHeader: string | null;
  secret: string;
  headers: Headers;
  nowSeconds?: number;
  maxAgeSeconds?: number;
};

type SignatureParts = {
  timestamp: string;
  headerNames: string;
  signature: string;
};

export type CdpWebhookAuthentication = {
  deliveryId: string;
  headerVariant: "event" | "hook0";
};

function parseSignatureHeader(value: string): SignatureParts | null {
  let timestamp: string | null = null;
  let headerNames: string | null = null;
  let signature: string | null = null;

  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const key = part.slice(0, separator);
    const fieldValue = part.slice(separator + 1);
    if (fieldValue.length === 0) return null;

    if (key === "t") {
      if (timestamp !== null) return null;
      timestamp = fieldValue;
    } else if (key === "h") {
      if (headerNames !== null) return null;
      headerNames = fieldValue;
    } else if (key === "v1") {
      if (signature !== null) return null;
      signature = fieldValue;
    }
  }

  return timestamp !== null && headerNames !== null && signature !== null
    ? { timestamp, headerNames, signature }
    : null;
}

function decodeSha256Hex(value: string): ArrayBuffer | null {
  if (value.length !== SHA256_HEX_LENGTH) return null;
  const buffer = new ArrayBuffer(SHA256_HEX_LENGTH / 2);
  const bytes = new Uint8Array(buffer);
  const alphabet = "0123456789abcdef";
  for (let index = 0; index < value.length; index += 2) {
    const high = alphabet.indexOf(value[index].toLowerCase());
    const low = alphabet.indexOf(value[index + 1].toLowerCase());
    if (high < 0 || low < 0) return null;
    bytes[index / 2] = high * 16 + low;
  }
  return buffer;
}

export async function authenticateCdpWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  headers,
  nowSeconds = Math.floor(Date.now() / 1_000),
  maxAgeSeconds = 300,
}: VerificationInput): Promise<CdpWebhookAuthentication | null> {
  if (!signatureHeader || !secret || !Number.isSafeInteger(nowSeconds) || maxAgeSeconds <= 0) return null;

  const parts = parseSignatureHeader(signatureHeader);
  if (!parts) return null;

  const timestamp = Number(parts.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || String(timestamp) !== parts.timestamp) return null;
  if (Math.abs(nowSeconds - timestamp) > maxAgeSeconds) return null;

  const headerNameList = parts.headerNames.split(" ");
  if (
    headerNameList.length === 0 ||
    headerNameList.some((name) => name.length === 0 || name !== name.toLowerCase()) ||
    new Set(headerNameList).size !== headerNameList.length ||
    !headerNameList.includes("content-type")
  ) {
    return null;
  }

  const eventHeaderVariant = headerNameList.includes("x-event-id") && headerNameList.includes("x-event-type");
  const hook0HeaderVariant = headerNameList.includes("x-hook0-id");
  if (!eventHeaderVariant && !hook0HeaderVariant) return null;
  if (eventHeaderVariant && headers.get("x-event-type") !== "onchain.activity.detected") return null;

  const headerVariant = eventHeaderVariant ? "event" : "hook0";
  const deliveryId = headers.get(headerVariant === "event" ? "x-event-id" : "x-hook0-id");
  if (!deliveryId) return null;

  const headerValues: string[] = [];
  for (const name of headerNameList) {
    const value = headers.get(name);
    if (value === null) return null;
    headerValues.push(value);
  }

  const signature = decodeSha256Hex(parts.signature);
  if (!signature) return null;
  const prefix = encoder.encode(`${parts.timestamp}.${parts.headerNames}.${headerValues.join(".")}.`);
  const signedPayload = new Uint8Array(prefix.length + rawBody.length);
  signedPayload.set(prefix, 0);
  signedPayload.set(rawBody, prefix.length);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, signedPayload);
    return valid ? { deliveryId, headerVariant } : null;
  } catch {
    return null;
  }
}

export async function verifyCdpWebhookSignature(input: VerificationInput): Promise<boolean> {
  return (await authenticateCdpWebhookSignature(input)) !== null;
}
