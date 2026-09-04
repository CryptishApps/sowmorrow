import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { getAddress, isAddress, isHash } from "viem";
import { z } from "zod";
import { parseDeploymentManifest } from "../../lib/contracts/manifests";
import { stockSymbols } from "../../lib/stocks";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureChainIdSchema = z.union([z.literal(31337), z.literal(84532)]);
type FixtureChainId = z.infer<typeof fixtureChainIdSchema>;

const configurationForChain = {
  31337: {
    network: "local",
    ownerKind: "local-eoa",
    artifact: "contracts/deployments/local-31337.generated.json",
    broadcast: "contracts/broadcast/DeployTestFixtures.s.sol/31337/run-latest.json",
    out: "contracts/deployments/local-31337.json",
  },
  84532: {
    network: "base-sepolia",
    ownerKind: "test-eoa",
    artifact: "contracts/deployments/base-sepolia-84532.generated.json",
    broadcast: "contracts/broadcast/DeployTestFixtures.s.sol/84532/run-latest.json",
    out: "contracts/deployments/base-sepolia-84532.json",
  },
} as const;

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid EVM address")
  .transform((value) => getAddress(value));

const runArtifactSchema = z
  .object({
    chainId: fixtureChainIdSchema,
    contractVersion: z.literal("1.0.0"),
    simulationBlock: z.number().int().nonnegative(),
    deployer: addressSchema,
    owner: addressSchema,
    vaultAddress: addressSchema,
    faucetAddress: addressSchema,
    runtimeBytecodeHash: z.string().refine((value) => isHash(value), "Invalid runtime bytecode hash"),
    startPaused: z.boolean(),
    fixtureNames: z.array(z.string().min(1)),
    fixtureSymbols: z.array(z.string().min(1)),
    fixtureAddresses: z.array(addressSchema),
  })
  .strict();

const broadcastSchema = z
  .object({
    chain: fixtureChainIdSchema,
    transactions: z.array(
      z.object({
        hash: z.string(),
        transactionType: z.string(),
        contractName: z.string().nullable().optional(),
        contractAddress: z.string().nullable().optional(),
      }),
    ),
    receipts: z.array(z.object({ transactionHash: z.string(), blockNumber: z.string() })),
  })
  .loose();

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function pendingManifest(chainId: FixtureChainId) {
  const configuration = configurationForChain[chainId];
  return {
    $schema: "./deployment-manifest.schema.json",
    schemaVersion: 1,
    contractVersion: "1.0.0",
    chainId,
    network: configuration.network,
    status: "pending",
    vaultAddress: null,
    deploymentBlock: null,
    runtimeBytecodeHash: null,
    owner: { kind: configuration.ownerKind, address: null },
    startPaused: false,
    expectedCreationPaused: null,
    catalogAddressSetSha256: null,
    stocks: [],
  } as const;
}

function buildActiveManifest(chainId: FixtureChainId, artifactPath: string, broadcastPath: string) {
  const configuration = configurationForChain[chainId];
  const artifact = runArtifactSchema.parse(readJson(artifactPath));
  const broadcast = broadcastSchema.parse(readJson(broadcastPath));
  if (artifact.chainId !== chainId || broadcast.chain !== chainId) {
    throw new Error("The fixture artifact, broadcast, and requested chain must agree");
  }

  const vaultCreations = broadcast.transactions.filter(
    (transaction) =>
      transaction.transactionType === "CREATE" && transaction.contractName === "SowmorrowVault",
  );
  if (vaultCreations.length !== 1) {
    throw new Error(`${broadcastPath}: expected exactly one SowmorrowVault creation`);
  }
  const [vaultCreation] = vaultCreations;
  if (
    typeof vaultCreation.contractAddress !== "string" ||
    !isAddress(vaultCreation.contractAddress) ||
    getAddress(vaultCreation.contractAddress) !== artifact.vaultAddress
  ) {
    throw new Error("The broadcast vault address does not match the deployment artifact");
  }

  const receipt = broadcast.receipts.find((entry) => entry.transactionHash === vaultCreation.hash);
  if (!receipt) throw new Error("The broadcast has no receipt for the vault creation");
  const deploymentBlock = Number(receipt.blockNumber);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0) {
    throw new Error("The vault creation receipt has no usable deployment block");
  }

  if (
    artifact.fixtureAddresses.length !== stockSymbols.length ||
    artifact.fixtureNames.length !== stockSymbols.length ||
    artifact.fixtureSymbols.length !== stockSymbols.length
  ) {
    throw new Error(
      `The fixture deployment must create exactly ${stockSymbols.length} fixtures, one per stock symbol`,
    );
  }

  return {
    $schema: "./deployment-manifest.schema.json",
    schemaVersion: 1,
    contractVersion: artifact.contractVersion,
    chainId,
    network: configuration.network,
    status: "active",
    vaultAddress: artifact.vaultAddress,
    deploymentBlock,
    runtimeBytecodeHash: artifact.runtimeBytecodeHash.toLowerCase(),
    owner: { kind: configuration.ownerKind, address: artifact.owner },
    startPaused: artifact.startPaused,
    expectedCreationPaused: artifact.startPaused,
    catalogAddressSetSha256: null,
    stocks: stockSymbols.map((symbol, index) => ({ symbol, address: artifact.fixtureAddresses[index] })),
  } as const;
}

const { values } = parseArgs({
  options: {
    "chain-id": { type: "string", default: "31337" },
    artifact: { type: "string" },
    broadcast: { type: "string" },
    out: { type: "string" },
    pending: { type: "boolean", default: false },
  },
});

const chainId = fixtureChainIdSchema.parse(Number(values["chain-id"]));
const configuration = configurationForChain[chainId];
const artifactPath = resolve(repositoryRoot, values.artifact ?? configuration.artifact);
const broadcastPath = resolve(repositoryRoot, values.broadcast ?? configuration.broadcast);
const out = values.out ?? configuration.out;
const manifest = values.pending
  ? pendingManifest(chainId)
  : buildActiveManifest(chainId, artifactPath, broadcastPath);

parseDeploymentManifest(manifest);
writeFileSync(resolve(repositoryRoot, out), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out} (${manifest.status})`);
