import { decodeEventLog, isAddressEqual } from "viem";
import type { Address, Hex } from "viem";
import { sowmorrowVaultAbi } from "./generated";

export type ReceiptLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
};

export type ReceiptProof = {
  status: string;
  logs: readonly ReceiptLog[];
};

export type GiftCreatedExpectation = {
  vault: Address;
  sender: Address;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
  noteHash: Hex;
};

export type GiftClaimedExpectation = {
  giftId: bigint;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
};

export type ReceiptProofErrorCode =
  "receipt_reverted" | "event_missing" | "event_duplicate" | "event_mismatch";

const receiptProofMessages: Record<ReceiptProofErrorCode, string> = {
  receipt_reverted: "The transaction reverted.",
  event_missing: "The expected vault event is missing.",
  event_duplicate: "The receipt contains an unexpected number of vault events.",
  event_mismatch: "The vault event does not match the submitted gift.",
};

export class ReceiptProofError extends Error {
  constructor(public readonly code: ReceiptProofErrorCode) {
    super(receiptProofMessages[code]);
    this.name = "ReceiptProofError";
  }
}

type CreatedEvent = {
  giftId: bigint;
  sender: Address;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
  noteHash: Hex;
};

type ClaimedEvent = GiftClaimedExpectation;

function decodeVaultEvents(receipt: ReceiptProof, vault: Address) {
  const created: CreatedEvent[] = [];
  const claimed: ClaimedEvent[] = [];

  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, vault) || log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: sowmorrowVaultAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName === "GiftCreated") created.push(decoded.args as CreatedEvent);
      if (decoded.eventName === "GiftClaimed") claimed.push(decoded.args as ClaimedEvent);
    } catch {
      continue;
    }
  }

  return { created, claimed };
}

function sameHex(left: Hex, right: Hex) {
  return left.toLowerCase() === right.toLowerCase();
}

function createdMatches(event: CreatedEvent, expected: GiftCreatedExpectation) {
  return (
    isAddressEqual(event.sender, expected.sender) &&
    isAddressEqual(event.recipient, expected.recipient) &&
    isAddressEqual(event.stock, expected.stock) &&
    event.amountRaw === expected.amountRaw &&
    event.unlockAt === expected.unlockAt &&
    sameHex(event.noteHash, expected.noteHash)
  );
}

function claimedMatches(event: ClaimedEvent, expected: GiftClaimedExpectation) {
  return (
    event.giftId === expected.giftId &&
    isAddressEqual(event.recipient, expected.recipient) &&
    isAddressEqual(event.stock, expected.stock) &&
    event.amountRaw === expected.amountRaw
  );
}

export function proveGiftCreated(receipt: ReceiptProof, expected: GiftCreatedExpectation) {
  if (receipt.status !== "success") throw new ReceiptProofError("receipt_reverted");
  const events = decodeVaultEvents(receipt, expected.vault).created;
  if (events.length === 0) throw new ReceiptProofError("event_missing");
  if (events.length > 1) throw new ReceiptProofError("event_duplicate");
  if (!createdMatches(events[0], expected)) throw new ReceiptProofError("event_mismatch");
  return { giftId: events[0].giftId };
}

export function proveGiftClaimed(
  receipt: ReceiptProof,
  vault: Address,
  expected: readonly GiftClaimedExpectation[],
) {
  if (receipt.status !== "success") throw new ReceiptProofError("receipt_reverted");
  const events = decodeVaultEvents(receipt, vault).claimed;
  if (events.length < expected.length) throw new ReceiptProofError("event_missing");
  if (events.length > expected.length) throw new ReceiptProofError("event_duplicate");

  const eventIds = new Set(events.map((event) => event.giftId));
  if (eventIds.size !== events.length) throw new ReceiptProofError("event_duplicate");
  if (expected.some((item) => !events.some((event) => claimedMatches(event, item)))) {
    throw new ReceiptProofError("event_mismatch");
  }
}
