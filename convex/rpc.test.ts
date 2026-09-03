import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hash } from "viem";

const { viemState } = vi.hoisted(() => ({
  viemState: { client: {} as Record<string, unknown>, chains: [] as unknown[] },
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (options: { chain: { id: number } }) => {
      viemState.chains.push(options.chain.id);
      return viemState.client;
    },
  };
});

const { B20_ASSET_VARIANT, b20FactoryAbi, createChainRpc, primaryRpcUrl, secondaryRpcUrl } =
  await import("./rpc");

const VAULT: Address = "0x1000000000000000000000000000000000000001";
const TOKEN: Address = "0x5000000000000000000000000000000000000005";
const FACTORY: Address = "0xB20F000000000000000000000000000000000000";
const TX: Hash = `0x${"1".repeat(64)}`;
const BLOCK_HASH: Hash = `0x${"2".repeat(64)}`;

beforeEach(() => {
  viemState.client = {};
  viemState.chains = [];
});

afterEach(() => {
  delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL;
  delete process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL;
  delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY;
  delete process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL_SECONDARY;
});

describe("configured RPC urls", () => {
  it("selects the url for each supported chain and nothing else", () => {
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL = "https://mainnet.test";
    process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL = "https://sepolia.test";
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY = "https://mainnet-2.test";
    process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL_SECONDARY = "https://sepolia-2.test";

    expect(primaryRpcUrl(8453)).toBe("https://mainnet.test");
    expect(primaryRpcUrl(84532)).toBe("https://sepolia.test");
    expect(primaryRpcUrl(1)).toBeUndefined();
    expect(secondaryRpcUrl(8453)).toBe("https://mainnet-2.test");
    expect(secondaryRpcUrl(84532)).toBe("https://sepolia-2.test");
    expect(secondaryRpcUrl(1)).toBeUndefined();
  });

  it("pins the asset variant discriminant and the factory event shape", () => {
    expect(B20_ASSET_VARIANT).toBe(0);
    const event = b20FactoryAbi.find((entry) => entry.type === "event");
    expect(event).toMatchObject({
      name: "B20Created",
      inputs: [
        { name: "token", type: "address", indexed: true },
        { name: "variant", type: "uint8", indexed: true },
        { name: "name", type: "string" },
        { name: "symbol", type: "string" },
        { name: "decimals", type: "uint8" },
        { name: "variantEventParams", type: "bytes" },
      ],
    });
  });
});

describe("viem-backed chain adapter", () => {
  it("maps blocks, receipts, vault logs, factory creations, and contract reads", async () => {
    viemState.client = {
      getChainId: async () => 8453,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({
        number: blockNumber ?? 4_000n,
        hash: BLOCK_HASH.toUpperCase(),
      }),
      getTransactionReceipt: async () => ({
        status: "success",
        transactionHash: TX,
        transactionIndex: 2,
        blockNumber: 100n,
        blockHash: BLOCK_HASH,
        logs: [
          { address: VAULT, logIndex: 7, topics: [TX], data: "0x01" },
          { address: VAULT, logIndex: null, topics: [], data: "0x" },
        ],
      }),
      getContractEvents: async ({ eventName }: { eventName: string }) =>
        eventName === "GiftCreated"
          ? [
              {
                transactionHash: TX,
                transactionIndex: 1,
                logIndex: 3,
                blockNumber: 100n,
                blockHash: BLOCK_HASH,
                topics: [TX],
                data: "0x01",
              },
            ]
          : eventName === "B20Created"
            ? [
                {
                  args: { token: TOKEN, variant: 0, name: "Apple", symbol: "AAPLc", decimals: 18 },
                  transactionHash: TX,
                  logIndex: 4,
                  blockNumber: 300n,
                  blockHash: BLOCK_HASH,
                },
              ]
            : [],
      getTransaction: async () => ({ from: VAULT }),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "name") return "Apple";
        if (functionName === "symbol") return "AAPLc";
        if (functionName === "decimals") return 18;
        if (functionName === "isB20") return true;
        if (functionName === "isB20Initialized") return true;
        if (functionName === "totalEscrowed") return 1_000n;
        return 2_000n;
      },
    };
    const rpc = createChainRpc(8453, "https://mainnet.test");

    await expect(rpc.getChainId()).resolves.toBe(8453);
    await expect(rpc.getSafeBlock()).resolves.toEqual({
      number: 4_000n,
      hashLower: BLOCK_HASH.toLowerCase(),
    });
    await expect(rpc.getBlock(100n)).resolves.toEqual({
      number: 100n,
      hashLower: BLOCK_HASH.toLowerCase(),
    });

    const receipt = await rpc.getTransactionReceipt(TX);
    expect(receipt).toMatchObject({ status: "success", transactionIndex: 2 });
    expect(receipt.logs.map((log) => log.logIndex)).toEqual([7, -1]);

    const vaultLogs = await rpc.getVaultEvents({ vault: VAULT, fromBlock: 0n, toBlock: 200n });
    expect(vaultLogs).toMatchObject([{ eventName: "GiftCreated", logIndex: 3, transactionIndex: 1 }]);

    const creations = await rpc.getFactoryCreations({ factory: FACTORY, fromBlock: 0n, toBlock: 400n });
    expect(creations).toMatchObject([{ symbol: "AAPLc", variant: 0, decimals: 18, logIndex: 4 }]);

    await expect(rpc.readTokenIdentity(TOKEN)).resolves.toEqual({
      name: "Apple",
      symbol: "AAPLc",
      decimals: 18,
    });
    await expect(rpc.readIsInitializedB20(FACTORY, TOKEN)).resolves.toBe(true);
    await expect(rpc.readTotalEscrowed(VAULT, TOKEN)).resolves.toBe(1_000n);
    await expect(rpc.readTokenBalance(TOKEN, VAULT)).resolves.toBe(2_000n);
  });

  it("refuses a pending block without a hash or a number", async () => {
    viemState.client = { getBlock: async () => ({ number: 1n, hash: null }) };
    await expect(createChainRpc(8453, "https://mainnet.test").getBlock(1n)).rejects.toThrow(
      "missing-block-hash",
    );

    viemState.client = { getBlock: async () => ({ number: null, hash: BLOCK_HASH }) };
    await expect(createChainRpc(84532, "https://sepolia.test").getSafeBlock()).rejects.toThrow(
      "missing-block-number",
    );
    expect(viemState.chains).toEqual([8453, 84532]);
  });

  it("refuses a vault log that is not yet mined into a block", async () => {
    viemState.client = {
      getContractEvents: async ({ eventName }: { eventName: string }) =>
        eventName === "GiftCreated"
          ? [
              {
                transactionHash: TX,
                transactionIndex: null,
                logIndex: null,
                blockNumber: null,
                blockHash: null,
                topics: [],
                data: "0x",
              },
            ]
          : [],
    };
    await expect(
      createChainRpc(8453, "https://mainnet.test").getVaultEvents({
        vault: VAULT,
        fromBlock: 0n,
        toBlock: 1n,
      }),
    ).rejects.toThrow("missing-block-hash");
  });
});
