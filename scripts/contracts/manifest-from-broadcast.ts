import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { getAddress, isAddress, isHash } from "viem";
import { z } from "zod";
import { parseDeploymentManifest } from "../../lib/contracts/manifests";
import { stockSymbols } from "../../lib/stocks";

const LOCAL_CHAIN_ID = 31337;
const repositoryRoot = resolve(import.meta.dirname, "../..");

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid EVM address")
  .transform((value) => getAddress(value));

const runArtifactSchema = z
  .object({
    chainId: z.literal(LOCAL_CHAIN_ID),
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
    chain: z.literal(LOCAL_CHAIN_ID),
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

const pendingManifest = {
  $schema: "./deployment-manifest.schema.json",
  schemaVersion: 1,
  contractVersion: "1.0.0",
  chainId: LOCAL_CHAIN_ID,
  network: "local",
  status: "pending",
  vaultAddress: null,
  deploymentBlock: null,
  runtimeBytecodeHash: null,
  owner: { kind: "local-eoa", address: null },
  startPaused: false,
  expectedCreationPaused: null,
  catalogAddressSetSha256: null,
  stocks: [],
} as const;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function buildActiveManifest(artifactPath: string, broadcastPath: string) {
  const artifact = runArtifactSchema.parse(readJson(artifactPath));
  const broadcast = broadcastSchema.parse(readJson(broadcastPath));

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
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
    throw new Error("The vault creation receipt has no usable block number");
  }
  if (deploymentBlock === 0) {
    throw new Error("The vault creation receipt reports the genesis block");
  }

  if (
    artifact.fixtureAddresses.length !== stockSymbols.length ||
    artifact.fixtureNames.length !== stockSymbols.length ||
    artifact.fixtureSymbols.length !== stockSymbols.length
  ) {
    throw new Error(
      `The local stack must create exactly ${stockSymbols.length} fixtures, one per reviewed rail symbol`,
    );
  }

  return {
    $schema: "./deployment-manifest.schema.json",
    schemaVersion: 1,
    contractVersion: artifact.contractVersion,
    chainId: LOCAL_CHAIN_ID,
    network: "local",
    status: "active",
    vaultAddress: artifact.vaultAddress,
    deploymentBlock,
    runtimeBytecodeHash: artifact.runtimeBytecodeHash.toLowerCase(),
    owner: { kind: "local-eoa", address: artifact.owner },
    startPaused: artifact.startPaused,
    expectedCreationPaused: artifact.startPaused,
    catalogAddressSetSha256: null,
    stocks: stockSymbols.map((symbol, index) => ({ symbol, address: artifact.fixtureAddresses[index] })),
  };
}

const { values } = parseArgs({
  options: {
    artifact: { type: "string", default: "contracts/deployments/local-31337.generated.json" },
    broadcast: {
      type: "string",
      default: "contracts/broadcast/DeployLocalFixtures.s.sol/31337/run-latest.json",
    },
    out: { type: "string", default: "contracts/deployments/local-31337.json" },
    pending: { type: "boolean", default: false },
  },
});

const outPath = resolve(repositoryRoot, values.out);
const manifest = values.pending
  ? pendingManifest
  : buildActiveManifest(resolve(repositoryRoot, values.artifact), resolve(repositoryRoot, values.broadcast));

parseDeploymentManifest(manifest);
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${values.out} (${manifest.status})`);
