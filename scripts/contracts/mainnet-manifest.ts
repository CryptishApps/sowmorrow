import { deploymentFactory, deploymentFactoryCode, prepareFactoryDeployment } from "./factory-deployment";
import {
  decodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  getAddress,
  isAddress,
  isHash,
  isHex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  zeroAddress,
} from "viem";
import type { Address, Hex, PublicClient, Transport } from "viem";
import { z } from "zod";
import type { base } from "viem/chains";
import { parseDeploymentManifest } from "../../lib/contracts/manifests";
import { sowmorrowVaultAbi } from "../../lib/contracts/generated";
import { stocks, stockCatalogEvidence } from "../../lib/stocks";

const broadcastSchema = z.object({
  chain: z.literal(8453),
  transactions: z.array(
    z.object({
      hash: z.string().refine(isHash),
      transactionType: z.string(),
      contractName: z.string().nullable().optional(),
      contractAddress: z.string().nullable().optional(),
    }),
  ),
});
const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const constructorTypes = parseAbiParameters(
  "address owner, address[] stocks, uint256[] minimums, bool paused",
);

export async function buildMainnetManifest(input: {
  client: PublicClient<Transport, typeof base>;
  expectedOwner: Address;
  ownerKind?: "safe" | "smart-wallet";
  creationCode: Hex;
  runtimeCode: Hex;
  broadcast: unknown;
  factoryDeployment?: ReturnType<typeof prepareFactoryDeployment>;
}) {
  const { client, creationCode, runtimeCode } = input;
  const expectedOwner = getAddress(input.expectedOwner);
  const ownerKind = z.enum(["safe", "smart-wallet"]).parse(input.ownerKind ?? "safe");
  if (!isHex(creationCode) || size(creationCode) === 0 || !isHex(runtimeCode) || size(runtimeCode) === 0)
    throw new Error("Compile the vault before generating a manifest");
  const broadcast = broadcastSchema.parse(input.broadcast);
  if ((await client.getChainId()) !== 8453) throw new Error("RPC must be Base mainnet");
  const creations = broadcast.transactions.filter(
    (tx) => tx.transactionType === "CREATE" && tx.contractName === "SowmorrowVault",
  );
  if (creations.length !== 1) throw new Error("Expected exactly one SowmorrowVault creation");
  const creation = creations[0];
  if (!creation.contractAddress || !isAddress(creation.contractAddress))
    throw new Error("Missing broadcast vault address");
  const vault = getAddress(creation.contractAddress);
  const hash = creation.hash as Hex;
  const receipt = await client.getTransactionReceipt({ hash });
  if (
    receipt.status !== "success" ||
    (!input.factoryDeployment && (!receipt.contractAddress || getAddress(receipt.contractAddress) !== vault))
  )
    throw new Error("Vault deployment did not succeed at the broadcast address");
  const deploymentBlock = Number(receipt.blockNumber);
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock <= 0)
    throw new Error("Invalid deployment block");
  const safeBlock = await client.getBlock({ blockTag: "safe" });
  if (safeBlock.number < receipt.blockNumber) throw new Error("Wait until deployment reaches the safe block");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error("Deployment receipt is not canonical");
  let initCode: Hex;
  if (input.factoryDeployment) {
    const expected = prepareFactoryDeployment(creationCode, expectedOwner);
    if (
      vault !== expected.vault ||
      input.factoryDeployment.initCode !== expected.initCode ||
      input.factoryDeployment.salt !== expected.salt
    )
      throw new Error("Factory request differs from the reviewed deployment");
    const factoryCode = await client.getBytecode({
      address: deploymentFactory,
      blockNumber: receipt.blockNumber,
    });
    if (factoryCode !== deploymentFactoryCode)
      throw new Error("Factory bytecode differs from the reviewed implementation");
    const previousCode = await client.getBytecode({ address: vault, blockNumber: receipt.blockNumber - 1n });
    if (previousCode && previousCode !== "0x")
      throw new Error("Vault existed before the reported deployment");
    const topics = encodeEventTopics({
      abi: [
        parseAbiItem("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"),
      ],
      eventName: "OwnershipTransferred",
      args: { previousOwner: zeroAddress, newOwner: expectedOwner },
    });
    if (
      !receipt.logs.some(
        (log) =>
          getAddress(log.address) === vault &&
          log.data === "0x" &&
          log.topics.length === topics.length &&
          log.topics.every((topic, index) => topic.toLowerCase() === String(topics[index]).toLowerCase()),
      )
    )
      throw new Error("Receipt does not contain the vault creation event");
    initCode = expected.initCode;
  } else {
    const tx = await client.getTransaction({ hash });
    if (tx.to !== null || slice(tx.input, 0, size(creationCode)) !== creationCode)
      throw new Error("Deployment transaction differs from the compiled vault");
    initCode = tx.input;
  }
  const [owner, deployedStocks, minimums, paused] = decodeAbiParameters(
    constructorTypes,
    slice(initCode, size(creationCode)),
  );
  if (getAddress(owner) !== expectedOwner || owner === zeroAddress || !paused)
    throw new Error("Deployment must use the reviewed owner and start paused");
  if (
    deployedStocks.length !== stocks.length ||
    minimums.length !== stocks.length ||
    deployedStocks.some((address, i) => getAddress(address) !== stocks[i].mainnetAddress) ||
    minimums.some((amount) => amount <= 0n || amount > 1000n * 10n ** 18n)
  )
    throw new Error("Deployment constructor differs from the reviewed stock catalog or minimum bounds");
  const blockNumber = safeBlock.number;
  const code = await client.getBytecode({ address: vault, blockNumber });
  if (code !== runtimeCode) throw new Error("Deployed runtime differs from the compiled vault");
  const ownerCode = await client.getBytecode({ address: owner, blockNumber });
  if (!ownerCode || ownerCode === "0x") throw new Error("Owner must be a deployed contract");
  const [actualOwner, version, creationPaused] = await Promise.all([
    client.readContract({ address: vault, abi: sowmorrowVaultAbi, functionName: "owner", blockNumber }),
    client.readContract({ address: vault, abi: sowmorrowVaultAbi, functionName: "VERSION", blockNumber }),
    client.readContract({
      address: vault,
      abi: sowmorrowVaultAbi,
      functionName: "creationPaused",
      blockNumber,
    }),
  ]);
  if (getAddress(actualOwner) !== expectedOwner || version !== "1.0.0" || !creationPaused)
    throw new Error("Vault must retain the reviewed owner, version, and paused launch state");
  if (ownerKind === "safe") {
    const [signers, threshold] = await Promise.all([
      client.readContract({ address: owner, abi: safeAbi, functionName: "getOwners", blockNumber }),
      client.readContract({ address: owner, abi: safeAbi, functionName: "getThreshold", blockNumber }),
    ]);
    if (
      signers.length < 3 ||
      threshold < 2n ||
      threshold > BigInt(signers.length) ||
      new Set(signers.map((signer) => signer.toLowerCase())).size !== signers.length ||
      signers.some((signer) => signer === zeroAddress || getAddress(signer) === expectedOwner)
    )
      throw new Error("Safe signer policy requires at least three distinct signers and two signatures");
  }
  for (const [index, stock] of stocks.entries()) {
    const [supported, minimum] = await Promise.all([
      client.readContract({
        address: vault,
        abi: sowmorrowVaultAbi,
        functionName: "supportedStock",
        args: [stock.mainnetAddress],
        blockNumber,
      }),
      client.readContract({
        address: vault,
        abi: sowmorrowVaultAbi,
        functionName: "minGiftAmountRaw",
        args: [stock.mainnetAddress],
        blockNumber,
      }),
    ]);
    if (!supported || minimum !== minimums[index])
      throw new Error("Stock support or minimum changed after deployment");
  }
  const finalBlock = await client.getBlock({ blockNumber });
  if (finalBlock.hash !== safeBlock.hash) throw new Error("Safe snapshot changed during verification; retry");
  return parseDeploymentManifest({
    $schema: "./deployment-manifest.schema.json",
    schemaVersion: 1,
    contractVersion: version,
    chainId: 8453,
    network: "base-mainnet",
    status: "active",
    vaultAddress: vault,
    deploymentBlock,
    runtimeBytecodeHash: keccak256(runtimeCode),
    owner: { kind: ownerKind, address: expectedOwner },
    startPaused: true,
    expectedCreationPaused: true,
    catalogAddressSetSha256: stockCatalogEvidence.addressSetSha256,
    stocks: stocks.map((stock) => ({ symbol: stock.symbol, address: stock.mainnetAddress })),
  });
}
