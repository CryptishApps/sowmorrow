import { getAddress, isAddress } from "viem";
import type { Address } from "viem";
import { deploymentRegistry, manifestForChain, manifestStockAddresses } from "./manifests";
import type { DeploymentManifest, DeploymentRegistry } from "./manifests";
import { networkNameForChain } from "./config";
import type { StockSymbol } from "@/lib/stocks";

const MAX_UINT256 = (1n << 256n) - 1n;
const manifestChainIds = [8453, 84532, 31337] as const;

export type GiftRouteChainId = (typeof manifestChainIds)[number];

export type GiftRouteTarget = {
  chainId: GiftRouteChainId;
  networkName: string;
  vault: Address;
  giftId: string;
  manifestStatus: DeploymentManifest["status"];
  vaultIsManifestVault: boolean;
  stockAddresses: Partial<Record<StockSymbol, Address>>;
};

export function parseGiftRoute(
  params: { chainId: string; vault: string; giftId: string },
  registry: DeploymentRegistry = deploymentRegistry,
): GiftRouteTarget | null {
  const chainId = manifestChainIds.find((candidate) => String(candidate) === params.chainId);
  if (chainId === undefined) return null;

  let manifest: DeploymentManifest;
  try {
    manifest = manifestForChain(chainId, registry);
  } catch {
    return null;
  }

  if (!isAddress(params.vault)) return null;
  const vault = getAddress(params.vault);

  let giftId: bigint;
  try {
    giftId = BigInt(params.giftId);
  } catch {
    return null;
  }
  if (giftId <= 0n || giftId > MAX_UINT256 || giftId.toString() !== params.giftId) return null;

  const manifestVault = manifest.vaultAddress;
  if (manifest.status === "active" && (manifestVault === null || manifestVault !== vault)) return null;

  return {
    chainId,
    networkName: networkNameForChain(chainId),
    vault,
    giftId: params.giftId,
    manifestStatus: manifest.status,
    vaultIsManifestVault: manifestVault !== null && manifestVault === vault,
    stockAddresses: manifestStockAddresses(manifest),
  };
}

export function giftRoutePath(chainId: number, vault: Address, giftId: bigint | string) {
  return `/gift/${chainId}/${vault}/${giftId}`;
}
