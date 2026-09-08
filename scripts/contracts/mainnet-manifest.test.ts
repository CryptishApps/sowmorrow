import { deploymentFactoryCode, deploymentFactory, prepareFactoryDeployment } from "./factory-deployment";
import {
  encodeEventTopics,
  parseAbiItem,
  encodeAbiParameters,
  concat,
  keccak256,
  parseAbiParameters,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { stocks } from "../../lib/stocks";
import { buildMainnetManifest } from "./mainnet-manifest";

const vault = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const hash = `0x${"12".repeat(32)}` as const;
const blockHash = `0x${"34".repeat(32)}` as const;
const creationCode = "0x60016000";
const runtimeCode = "0x60026000";
const constructorTypes = parseAbiParameters("address, address[], uint256[], bool");
function setup() {
  const receipt = {
    status: "success",
    contractAddress: vault,
    blockNumber: 100n,
    blockHash,
    transactionHash: hash,
  };
  const client = {
    getChainId: vi.fn().mockResolvedValue(8453),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlock: vi.fn().mockResolvedValue({ number: 100n, hash: blockHash }),
    getTransaction: vi.fn().mockResolvedValue({
      to: null,
      input: concat([
        creationCode,
        encodeAbiParameters(constructorTypes, [
          owner,
          stocks.map((s) => s.mainnetAddress),
          stocks.map(() => 10n ** 16n),
          true,
        ]),
      ]),
    }),
    getBytecode: vi
      .fn()
      .mockImplementation(async ({ address }) => (address === vault ? runtimeCode : "0x6003")),
    readContract: vi.fn().mockImplementation(async ({ functionName }) => {
      switch (functionName) {
        case "owner":
          return owner;
        case "VERSION":
          return "1.0.0";
        case "creationPaused":
          return true;
        case "supportedStock":
          return true;
        case "minGiftAmountRaw":
          return 10n ** 16n;
        case "getThreshold":
          return 2n;
        case "getOwners":
          return [
            "0x3333333333333333333333333333333333333333",
            "0x4444444444444444444444444444444444444444",
            "0x5555555555555555555555555555555555555555",
          ];
      }
    }),
  };
  const input = {
    client: client as unknown as Parameters<typeof buildMainnetManifest>[0]["client"],
    expectedOwner: owner,
    creationCode,
    runtimeCode,
    broadcast: {
      chain: 8453,
      transactions: [
        { hash, transactionType: "CREATE", contractName: "SowmorrowVault", contractAddress: vault },
      ],
    },
  } as const;
  return { client, receipt, input };
}
describe("mainnet deployment evidence", () => {
  it("builds an active manifest only from a canonical successful deployment matching compiled code", async () => {
    const { input } = setup();
    await expect(buildMainnetManifest(input)).resolves.toMatchObject({
      chainId: 8453,
      status: "active",
      deploymentBlock: 100,
      vaultAddress: vault,
      owner: { kind: "safe", address: owner },
      startPaused: true,
      runtimeBytecodeHash: keccak256(runtimeCode),
    });
  });
  it("accepts an explicitly selected deployed smart wallet without requiring Safe signers", async () => {
    const { client, input } = setup();
    const read = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (args) => {
      if (args.functionName === "getOwners" || args.functionName === "getThreshold")
        throw new Error("Not a Safe");
      return read(args);
    });
    await expect(buildMainnetManifest({ ...input, ownerKind: "smart-wallet" })).resolves.toMatchObject({
      owner: { kind: "smart-wallet", address: owner },
    });
    client.getBytecode.mockImplementation(async ({ address }) => (address === vault ? runtimeCode : "0x"));
    await expect(buildMainnetManifest({ ...input, ownerKind: "smart-wallet" })).rejects.toThrow("deployed");
  });
  it("verifies factory deployment inside a smart-wallet transaction and rejects missing creation evidence", async () => {
    const { client, receipt, input } = setup();
    const request = prepareFactoryDeployment(creationCode, owner);
    const read = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (args) =>
      args.functionName === "minGiftAmountRaw"
        ? [stocks[5].mainnetAddress, stocks[10].mainnetAddress].includes(args.args[0])
          ? 20_000_000n
          : 1_000_000n
        : read(args),
    );

    client.getTransactionReceipt.mockResolvedValue({
      ...receipt,
      contractAddress: null,
      logs: [
        {
          address: request.vault,
          topics: encodeEventTopics({
            abi: [
              parseAbiItem(
                "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
              ),
            ],
            eventName: "OwnershipTransferred",
            args: { previousOwner: "0x0000000000000000000000000000000000000000", newOwner: owner },
          }),
          data: "0x",
        },
      ],
    } as never);
    client.getBytecode.mockImplementation(
      async ({ address, blockNumber }: { address: string; blockNumber?: bigint }) =>
        address === deploymentFactory
          ? deploymentFactoryCode
          : address === request.vault
            ? blockNumber === 99n
              ? "0x"
              : runtimeCode
            : "0x6003",
    );
    const evidence = {
      ...input,
      ownerKind: "smart-wallet" as const,
      factoryDeployment: request,
      broadcast: {
        chain: 8453,
        transactions: [
          { hash, transactionType: "CREATE", contractName: "SowmorrowVault", contractAddress: request.vault },
        ],
      },
    };
    await expect(buildMainnetManifest(evidence)).resolves.toMatchObject({ vaultAddress: request.vault });
    client.getTransactionReceipt.mockResolvedValue({ ...receipt, contractAddress: null, logs: [] } as never);
    await expect(buildMainnetManifest(evidence)).rejects.toThrow("creation event");
  });
  it.each([
    "reverted",
    "orphaned",
    "code_mismatch",
    "wrong_owner",
    "not_safe_yet",
    "unpaused_constructor",
    "weak_safe",
    "unsupported_stock",
    "changed_snapshot",
  ])("rejects %s evidence", async (failure) => {
    const { client, receipt, input } = setup();
    if (failure === "reverted")
      client.getTransactionReceipt.mockResolvedValue({ ...receipt, status: "reverted" });
    if (failure === "orphaned")
      client.getTransactionReceipt.mockResolvedValue({ ...receipt, blockHash: hash });
    if (failure === "code_mismatch") client.getBytecode.mockResolvedValue("0x6000");
    if (failure === "wrong_owner")
      client.readContract.mockImplementation(async () => "0x6666666666666666666666666666666666666666");
    if (failure === "not_safe_yet") client.getBlock.mockResolvedValue({ number: 99n, hash: blockHash });
    if (failure === "weak_safe" || failure === "unsupported_stock") {
      const read = client.readContract.getMockImplementation()!;
      client.readContract.mockImplementation(async (args) => {
        if (failure === "weak_safe" && args.functionName === "getThreshold") return 1n;
        if (failure === "unsupported_stock" && args.functionName === "supportedStock") return false;
        return read(args);
      });
    }
    if (failure === "changed_snapshot")
      client.getBlock
        .mockResolvedValueOnce({ number: 100n, hash: blockHash })
        .mockResolvedValueOnce({ number: 100n, hash: blockHash })
        .mockResolvedValueOnce({ number: 100n, hash });
    if (failure === "unpaused_constructor")
      client.getTransaction.mockResolvedValue({
        to: null,
        input: concat([
          creationCode,
          encodeAbiParameters(constructorTypes, [
            owner,
            stocks.map((s) => s.mainnetAddress),
            stocks.map(() => 10n ** 16n),
            false,
          ]),
        ]),
      });
    await expect(buildMainnetManifest(input)).rejects.toThrow();
  });
});
