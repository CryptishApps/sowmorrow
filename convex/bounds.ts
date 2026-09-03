import { ConvexError } from "convex/values";
import { getAddress, isAddress } from "viem";
import { deploymentRegistry } from "../lib/contracts/manifests";

export const MAX_PAGE_ITEMS = 100;
export const MAX_NOTE_BYTES = 280;
const MAX_UINT256 = (1n << 256n) - 1n;

export type ManifestChainId = 8453 | 84532 | 31337;

export function assertManifestChainId(chainId: number): ManifestChainId {
  const manifest = deploymentRegistry[chainId as ManifestChainId];
  if (manifest === undefined || manifest.chainId !== chainId) {
    throw new ConvexError({ code: "UNKNOWN_CHAIN_ID" });
  }
  return manifest.chainId;
}

export function assertManifestVault(chainId: number, vault: string) {
  const manifest = deploymentRegistry[assertManifestChainId(chainId)];
  if (!isAddress(vault) || getAddress(vault) !== vault) {
    throw new ConvexError({ code: "INVALID_VAULT_ADDRESS" });
  }
  const expected = manifest?.vaultAddress;
  if (!expected || expected.toLowerCase() !== vault.toLowerCase()) {
    throw new ConvexError({ code: "UNKNOWN_VAULT" });
  }
  return vault.toLowerCase();
}

export function assertGiftId(giftId: string) {
  let parsed: bigint;
  try {
    parsed = BigInt(giftId);
  } catch {
    throw new ConvexError({ code: "INVALID_GIFT_ID" });
  }
  if (parsed <= 0n || parsed > MAX_UINT256 || parsed.toString() !== giftId) {
    throw new ConvexError({ code: "INVALID_GIFT_ID" });
  }
  return giftId;
}

export function assertRecipientAddress(recipientLower: string) {
  if (!isAddress(recipientLower) || recipientLower !== recipientLower.toLowerCase()) {
    throw new ConvexError({ code: "INVALID_RECIPIENT" });
  }
  return recipientLower;
}

export function clampPagination<T extends { numItems: number }>(paginationOpts: T): T {
  const numItems = Number.isSafeInteger(paginationOpts.numItems)
    ? Math.min(Math.max(paginationOpts.numItems, 1), MAX_PAGE_ITEMS)
    : MAX_PAGE_ITEMS;
  return { ...paginationOpts, numItems };
}
