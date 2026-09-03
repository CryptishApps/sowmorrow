import { getAddress, isAddress, isHash } from "viem";
import type { Address, Hash } from "viem";
import { z } from "zod";
import mainnetJson from "../../contracts/deployments/base-mainnet-8453.json";
import sepoliaJson from "../../contracts/deployments/base-sepolia-84532.json";
import localJson from "../../contracts/deployments/local-31337.json";
import { stockCatalogEvidence, stocks, stockSymbols } from "../stocks";
import type { StockSymbol } from "../stocks";

const networkForChain = {
  8453: "base-mainnet",
  84532: "base-sepolia",
  31337: "local",
} as const;

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid EVM address")
  .transform((value) => getAddress(value));
const runtimeHashSchema = z
  .string()
  .refine((value) => isHash(value), "Invalid runtime bytecode hash")
  .transform((value) => value.toLowerCase() as Hash);
const sha256Schema = z.string().length(64);

const deploymentManifestSchema = z
  .object({
    $schema: z.literal("./deployment-manifest.schema.json").optional(),
    schemaVersion: z.literal(1),
    contractVersion: z.literal("1.0.0"),
    chainId: z.union([z.literal(8453), z.literal(84532), z.literal(31337)]),
    network: z.enum(["base-mainnet", "base-sepolia", "local"]),
    status: z.enum(["pending", "active", "retired"]),
    vaultAddress: addressSchema.nullable(),
    deploymentBlock: z.number().int().nonnegative().safe().nullable(),
    runtimeBytecodeHash: runtimeHashSchema.nullable(),
    owner: z
      .object({
        kind: z.enum(["safe", "test-safe", "local-eoa"]),
        address: addressSchema.nullable(),
      })
      .strict(),
    startPaused: z.boolean(),
    expectedCreationPaused: z.boolean().nullable(),
    catalogAddressSetSha256: sha256Schema.nullable(),
    stocks: z.array(z.object({ symbol: z.enum(stockSymbols), address: addressSchema }).strict()),
  })
  .strict();

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type DeploymentRegistry = Partial<Record<8453 | 84532 | 31337, DeploymentManifest>>;

export function parseDeploymentManifest(input: unknown): DeploymentManifest {
  const manifest = deploymentManifestSchema.parse(input);
  if (manifest.network !== networkForChain[manifest.chainId]) {
    throw new Error("Deployment manifest chain and network disagree");
  }

  const deployed = manifest.status !== "pending";
  if (
    deployed !==
    (manifest.vaultAddress !== null &&
      manifest.deploymentBlock !== null &&
      manifest.runtimeBytecodeHash !== null &&
      manifest.owner.address !== null &&
      manifest.expectedCreationPaused !== null)
  ) {
    throw new Error("A deployed manifest requires a vault, block, runtime hash, and owner");
  }

  const symbols = new Set<StockSymbol>();
  const addresses = new Set<string>();
  for (const stock of manifest.stocks) {
    const addressLower = stock.address.toLowerCase();
    if (symbols.has(stock.symbol) || addresses.has(addressLower)) {
      throw new Error("Deployment manifest stock symbols and addresses must be unique");
    }
    symbols.add(stock.symbol);
    addresses.add(addressLower);
  }

  if (manifest.chainId === 8453) {
    if (manifest.owner.kind !== "safe" || !manifest.startPaused) {
      throw new Error("Base mainnet requires a Safe owner and paused launch");
    }
    if (manifest.catalogAddressSetSha256 !== stockCatalogEvidence.addressSetSha256) {
      throw new Error("Base mainnet manifest catalog evidence is stale");
    }
    const expected = stocks.map((stock) => [stock.symbol, stock.mainnetAddress.toLowerCase()] as const);
    const actual = manifest.stocks.map((stock) => [stock.symbol, stock.address.toLowerCase()] as const);
    if (
      actual.length !== expected.length ||
      actual.some(
        ([symbol, address], index) => symbol !== expected[index]?.[0] || address !== expected[index]?.[1],
      )
    ) {
      throw new Error("Base mainnet manifest differs from the reviewed stock catalog");
    }
  }

  if (manifest.chainId === 84532 && manifest.owner.kind !== "test-safe") {
    throw new Error("Base Sepolia requires a test Safe owner");
  }
  if (manifest.chainId === 31337 && manifest.owner.kind !== "local-eoa") {
    throw new Error("Local deployments require a local EOA owner");
  }
  if (manifest.status === "active" && manifest.stocks.length === 0) {
    throw new Error("An active deployment requires at least one supported stock");
  }

  return manifest;
}

const mainnet = parseDeploymentManifest(mainnetJson);
const sepolia = parseDeploymentManifest(sepoliaJson);
const local = parseDeploymentManifest(localJson);

export const deploymentRegistry: DeploymentRegistry = {
  [mainnet.chainId]: mainnet,
  [sepolia.chainId]: sepolia,
  [local.chainId]: local,
};

export function manifestForChain(
  chainId: 8453 | 84532 | 31337,
  registry: DeploymentRegistry = deploymentRegistry,
) {
  const manifest = registry[chainId];
  if (!manifest) throw new Error(`No checked deployment manifest for chain ${chainId}`);
  return manifest;
}

export function activeManifestForChain(
  chainId: 8453 | 84532,
  registry: DeploymentRegistry = deploymentRegistry,
) {
  const manifest = manifestForChain(chainId, registry);
  if (
    manifest.status !== "active" ||
    manifest.vaultAddress === null ||
    manifest.deploymentBlock === null ||
    manifest.runtimeBytecodeHash === null ||
    manifest.owner.address === null
  ) {
    throw new Error(`Chain ${chainId} has no active checked deployment manifest`);
  }
  return {
    ...manifest,
    status: "active" as const,
    vaultAddress: manifest.vaultAddress,
    deploymentBlock: manifest.deploymentBlock,
    runtimeBytecodeHash: manifest.runtimeBytecodeHash,
    owner: { ...manifest.owner, address: manifest.owner.address },
  };
}

export function activeManifestFromEnvironment(environment: { SOWMORROW_DEPLOYMENT_CHAIN_ID?: string }) {
  const configured = environment.SOWMORROW_DEPLOYMENT_CHAIN_ID;
  if (configured !== "8453" && configured !== "84532") {
    throw new Error("SOWMORROW_DEPLOYMENT_CHAIN_ID must select Base mainnet or Base Sepolia");
  }
  return activeManifestForChain(Number(configured) as 8453 | 84532);
}

export function manifestStockAddresses(manifest: DeploymentManifest) {
  return Object.fromEntries(manifest.stocks.map((stock) => [stock.symbol, stock.address])) as Partial<
    Record<StockSymbol, Address>
  >;
}
