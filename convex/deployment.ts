import type { Address } from "viem";
import { activeManifestFromEnvironment } from "../lib/contracts/manifests";
import { createChainRpc, primaryRpcUrl, secondaryRpcUrl } from "./rpc";
import type { ChainRpc } from "./rpc";

export type IndexedNetwork = "base-mainnet" | "base-sepolia";

export type ConfiguredDeployment = {
  chainId: number;
  network: IndexedNetwork;
  vaultAddress: Address;
  vaultAddressLower: string;
  vaultAddressChecksum: Address;
  deploymentBlock: number;
  primary: ChainRpc;
  secondary: ChainRpc | null;
};

export function configuredDeployment(): ConfiguredDeployment | null {
  let manifest;
  try {
    manifest = activeManifestFromEnvironment({
      SOWMORROW_DEPLOYMENT_CHAIN_ID: process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID,
    });
  } catch {
    return null;
  }
  if (manifest.network !== "base-mainnet" && manifest.network !== "base-sepolia") return null;
  const url = primaryRpcUrl(manifest.chainId);
  if (!url) return null;
  const secondaryUrl = secondaryRpcUrl(manifest.chainId);
  return {
    chainId: manifest.chainId,
    network: manifest.network,
    vaultAddress: manifest.vaultAddress,
    vaultAddressLower: manifest.vaultAddress.toLowerCase(),
    vaultAddressChecksum: manifest.vaultAddress,
    deploymentBlock: manifest.deploymentBlock,
    primary: createChainRpc(manifest.chainId, url),
    secondary: secondaryUrl ? createChainRpc(manifest.chainId, secondaryUrl) : null,
  };
}

export function rangeBackfillEnabled() {
  return process.env.SOWMORROW_INDEXER_ENABLED === "true";
}

export function retentionSeconds() {
  const configured = Number(process.env.SOWMORROW_RETENTION_DAYS);
  const days = Number.isSafeInteger(configured) && configured > 0 ? configured : 30;
  return days * 24 * 60 * 60;
}
