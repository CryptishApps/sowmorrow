import {
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  toCoinType,
  zeroAddress,
  zeroHash,
} from "viem";
import { base } from "viem/chains";
import { namehash, normalize } from "viem/ens";
import type { Address, PublicClient } from "viem";
import { identityNetwork } from "@/lib/web3/identity";

export const MAX_GIFT_NOTE_BYTES = 280;
export const UNLOCK_SAFETY_MARGIN_SECONDS = 300n;
const AMOUNT_PARSE_GUARD_DECIMALS = 256;
const MAX_AMOUNT_INPUT_LENGTH = 256;
const MAX_UINT64 = (1n << 64n) - 1n;
const noteEncoder = new TextEncoder();

type EnsClient = {
  getEnsAddress: (parameters: { name: string; coinType: bigint }) => Promise<Address | null>;
};

type BaseIdentityClient = Pick<PublicClient, "readContract"> & {
  chainId: Parameters<typeof identityNetwork>[0];
};

const identityAbi = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);

export function parseGiftAmount(input: string, decimals: number): bigint | null {
  if (
    input.length === 0 ||
    input.length > MAX_AMOUNT_INPUT_LENGTH ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return null;
  }
  try {
    const guardScale = 10n ** BigInt(AMOUNT_PARSE_GUARD_DECIMALS);
    const guarded = parseUnits(input, decimals + AMOUNT_PARSE_GUARD_DECIMALS);
    if (guarded % guardScale !== 0n) return null;
    const amountRaw = guarded / guardScale;
    return amountRaw > 0n ? amountRaw : null;
  } catch {
    return null;
  }
}

export function toUnlockAt(dateInput: string): bigint | null {
  const parts = dateInput.split("-");
  if (
    dateInput.length !== 10 ||
    parts.length !== 3 ||
    parts[0].length !== 4 ||
    parts[1].length !== 2 ||
    parts[2].length !== 2
  ) {
    return null;
  }
  const [year, month, day] = parts.map(Number);
  if (![year, month, day].every(Number.isSafeInteger)) return null;

  const local = new Date(0);
  local.setFullYear(year, month - 1, day);
  local.setHours(9, 0, 0, 0);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) {
    return null;
  }
  const milliseconds = local.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  const seconds = BigInt(milliseconds / 1_000);
  return seconds <= MAX_UINT64 ? seconds : null;
}

export function minimumUnlockDate(nowMilliseconds = Date.now()): string {
  const earliest = new Date(nowMilliseconds);
  earliest.setHours(9, 0, 0, 0);
  if (earliest.getTime() <= nowMilliseconds + Number(UNLOCK_SAFETY_MARGIN_SECONDS) * 1_000) {
    earliest.setDate(earliest.getDate() + 1);
  }
  return `${String(earliest.getFullYear()).padStart(4, "0")}-${String(earliest.getMonth() + 1).padStart(2, "0")}-${String(earliest.getDate()).padStart(2, "0")}`;
}

export function daysUntil(dateInput: string, nowMilliseconds = Date.now()): number | null {
  const unlockAt = toUnlockAt(dateInput);
  if (unlockAt === null) return null;
  const remaining = Number(unlockAt) * 1_000 - nowMilliseconds;
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}

export function hashGiftNote(note: string): `0x${string}` {
  const bytes = noteEncoder.encode(note);
  if (bytes.byteLength > MAX_GIFT_NOTE_BYTES) {
    throw new RangeError(`Gift notes must not exceed ${MAX_GIFT_NOTE_BYTES} UTF-8 bytes`);
  }
  return bytes.byteLength === 0 ? zeroHash : keccak256(bytes);
}

export function noteByteLength(note: string): number {
  return noteEncoder.encode(note).byteLength;
}

export function isGiftNoteValid(note: string): boolean {
  return noteByteLength(note) <= MAX_GIFT_NOTE_BYTES;
}

export function formatUnlockReview(unlockAt: bigint): {
  localDate: string;
  timeZone: string;
  utc: string;
} {
  const date = new Date(Number(unlockAt) * 1_000);
  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  });
  return {
    localDate: formatter.format(date),
    timeZone: formatter.resolvedOptions().timeZone,
    utc: date.toISOString(),
  };
}

export async function resolveRecipient(
  input: string,
  client: EnsClient,
  identity?: BaseIdentityClient,
): Promise<Address | null> {
  const candidate = input.trim();
  if (isAddress(candidate)) return getAddress(candidate);
  const name = normalize(candidate);
  const network = identityNetwork(identity?.chainId ?? base.id);
  if (identity) {
    const node = namehash(name);
    const resolver = await identity.readContract({
      address: network.registry,
      abi: identityAbi,
      functionName: "resolver",
      args: [node],
    });
    if (resolver !== zeroAddress) {
      const chainAddress = await identity.readContract({
        address: resolver,
        abi: identityAbi,
        functionName: "addr",
        args: [node, toCoinType(network.baseChainId)],
      });
      const resolved =
        chainAddress === "0x"
          ? await identity.readContract({
              address: resolver,
              abi: identityAbi,
              functionName: "addr",
              args: [node],
            })
          : chainAddress;
      return !isAddress(resolved) || resolved === zeroAddress ? null : getAddress(resolved);
    }
  }
  const resolved = await client.getEnsAddress({ name, coinType: toCoinType(network.baseChainId) });
  return resolved === null || resolved === zeroAddress ? null : getAddress(resolved);
}
