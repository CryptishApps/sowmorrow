import type { Address, Hash } from "viem";
import { base, baseSepolia, foundry } from "viem/chains";
import type { StockSymbol } from "@/lib/stocks";
import { deploymentRegistry, manifestForChain, manifestStockAddresses } from "@/lib/contracts/manifests";
import type { DeploymentRegistry } from "@/lib/contracts/manifests";

type PublicEnvironment = {
  NEXT_PUBLIC_SOWMORROW_CHAIN_ID?: string;
  NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED?: string;
  NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED?: string;
};

export type AppDeployment = {
  chainId: typeof base.id | typeof baseSepolia.id | typeof foundry.id;
  networkName: string;
  manifestStatus: "pending" | "active" | "retired";
  contractVersion: "1.0.0";
  vaultAddress: Address | null;
  runtimeBytecodeHash: Hash | null;
  writesEnabled: boolean;
  deploymentBlock: number | null;
  stockAddresses: Partial<Record<StockSymbol, Address>>;
};

const supportedChainIds = [base.id, baseSepolia.id, foundry.id] as const;

export function networkNameForChain(chainId: (typeof supportedChainIds)[number]): string {
  return chainId === base.id ? base.name : chainId === baseSepolia.id ? baseSepolia.name : foundry.name;
}

function parseBoolean(value: string | undefined, variableName: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${variableName} must be either true or false`);
}

export function parseAppDeployment(
  environment: PublicEnvironment,
  registry: DeploymentRegistry = deploymentRegistry,
): AppDeployment {
  const requestedChainId = Number(environment.NEXT_PUBLIC_SOWMORROW_CHAIN_ID ?? base.id);
  const chainId = supportedChainIds.find((supported) => supported === requestedChainId);
  if (chainId === undefined) {
    throw new Error(`Unsupported Sowmorrow chain: ${requestedChainId}`);
  }

  const manifest = manifestForChain(chainId, registry);
  const writesEnabled = parseBoolean(
    environment.NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED,
    "NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED",
  );
  const mainnetReleased = parseBoolean(
    environment.NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED,
    "NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED",
  );

  if (writesEnabled && manifest.status !== "active") {
    throw new Error("Writes require an active manifest from the checked deployment registry");
  }
  if (writesEnabled && chainId === base.id && !mainnetReleased) {
    throw new Error("The explicit mainnet release gate is required before Base writes can be enabled");
  }

  return {
    chainId,
    networkName: networkNameForChain(chainId),
    manifestStatus: manifest.status,
    contractVersion: manifest.contractVersion,
    vaultAddress: manifest.vaultAddress,
    runtimeBytecodeHash: manifest.runtimeBytecodeHash,
    writesEnabled,
    deploymentBlock: manifest.deploymentBlock,
    stockAddresses: manifestStockAddresses(manifest),
  };
}

export function getAppDeployment(): AppDeployment {
  return parseAppDeployment({
    NEXT_PUBLIC_SOWMORROW_CHAIN_ID: process.env.NEXT_PUBLIC_SOWMORROW_CHAIN_ID,
    NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: process.env.NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED,
    NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED: process.env.NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED,
  });
}
