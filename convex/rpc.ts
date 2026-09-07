import { createPublicClient, getAddress, http } from "viem";
import type { Address, Hash, Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { ib20AssetAbi, sowmorrowVaultAbi } from "../lib/contracts/generated";

export const b20FactoryAbi = [
  {
    type: "event",
    anonymous: false,
    name: "B20Created",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "variant", type: "uint8", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "decimals", type: "uint8", indexed: false },
      { name: "variantEventParams", type: "bytes", indexed: false },
    ],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "isB20",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "isB20Initialized",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const B20_ASSET_VARIANT = 0;

export type BlockRef = { number: bigint; hashLower: string };

export type ChainLog = {
  address: string;
  logIndex: number;
  topics: readonly Hex[];
  data: Hex;
};

export type ChainReceipt = {
  status: "success" | "reverted";
  transactionHash: Hash;
  transactionIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
  logs: readonly ChainLog[];
};

export type VaultEventLog = {
  eventName: "GiftCreated" | "GiftClaimed";
  transactionHash: Hash;
  transactionIndex: number;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
  topics: readonly Hex[];
  data: Hex;
};

export type FactoryCreationLog = {
  token: Address;
  variant: number;
  name: string;
  symbol: string;
  decimals: number;
  creator: Address;
  transactionHash: Hash;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
};

export type TokenIdentity = { name: string; symbol: string; decimals: number };

export type ChainRpc = {
  getChainId: () => Promise<number>;
  getSafeBlock: () => Promise<BlockRef>;
  getBlock: (blockNumber: bigint) => Promise<BlockRef | null>;
  getTransactionReceipt: (hash: Hash) => Promise<ChainReceipt>;
  getVaultEvents: (input: { vault: Address; fromBlock: bigint; toBlock: bigint }) => Promise<VaultEventLog[]>;
  getFactoryCreations: (input: {
    factory: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<FactoryCreationLog[]>;
  readTokenIdentity: (token: Address) => Promise<TokenIdentity>;
  readIsInitializedB20: (factory: Address, token: Address) => Promise<boolean>;
  readTotalEscrowed: (vault: Address, stock: Address, blockNumber?: bigint) => Promise<bigint>;
  readTokenBalance: (token: Address, holder: Address, blockNumber?: bigint) => Promise<bigint>;
};

export function primaryRpcUrl(chainId: number) {
  if (chainId === base.id) return process.env.SOWMORROW_BASE_MAINNET_RPC_URL;
  if (chainId === baseSepolia.id) return process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL;
  return undefined;
}

export function secondaryRpcUrl(chainId: number) {
  if (chainId === base.id) return process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY;
  if (chainId === baseSepolia.id) return process.env.SOWMORROW_BASE_SEPOLIA_RPC_URL_SECONDARY;
  return undefined;
}

function requireHash(value: Hash | null): Hash {
  if (value === null) throw new Error("missing-block-hash");
  return value;
}

export function createChainRpc(chainId: number, url: string): ChainRpc {
  const client =
    chainId === base.id
      ? createPublicClient({ chain: base, transport: http(url) })
      : createPublicClient({ chain: baseSepolia, transport: http(url) });

  async function blockRef(block: { number: bigint | null; hash: Hash | null }): Promise<BlockRef> {
    if (block.number === null) throw new Error("missing-block-number");
    return { number: block.number, hashLower: requireHash(block.hash).toLowerCase() };
  }

  return {
    getChainId: () => client.getChainId(),
    getSafeBlock: async () => blockRef(await client.getBlock({ blockTag: "safe" })),
    getBlock: async (blockNumber) => blockRef(await client.getBlock({ blockNumber })),
    getTransactionReceipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          logIndex: log.logIndex ?? -1,
          topics: log.topics,
          data: log.data,
        })),
      };
    },
    getVaultEvents: async ({ vault, fromBlock, toBlock }) => {
      const [created, claimed] = await Promise.all([
        client.getContractEvents({
          address: vault,
          abi: sowmorrowVaultAbi,
          eventName: "GiftCreated",
          fromBlock,
          toBlock,
          strict: true,
        }),
        client.getContractEvents({
          address: vault,
          abi: sowmorrowVaultAbi,
          eventName: "GiftClaimed",
          fromBlock,
          toBlock,
          strict: true,
        }),
      ]);
      return [
        ...created.map((log) => ({ eventName: "GiftCreated" as const, log })),
        ...claimed.map((log) => ({ eventName: "GiftClaimed" as const, log })),
      ].map(({ eventName, log }) => ({
        eventName,
        transactionHash: requireHash(log.transactionHash),
        transactionIndex: log.transactionIndex ?? -1,
        logIndex: log.logIndex ?? -1,
        blockNumber: log.blockNumber ?? -1n,
        blockHash: requireHash(log.blockHash),
        topics: log.topics,
        data: log.data,
      }));
    },
    getFactoryCreations: async ({ factory, fromBlock, toBlock }) => {
      const logs = await client.getContractEvents({
        address: factory,
        abi: b20FactoryAbi,
        eventName: "B20Created",
        fromBlock,
        toBlock,
        strict: true,
      });
      const withCreators = await Promise.all(
        logs.map(async (log) => {
          const transaction = await client.getTransaction({ hash: requireHash(log.transactionHash) });
          return {
            token: getAddress(log.args.token),
            variant: Number(log.args.variant),
            name: log.args.name,
            symbol: log.args.symbol,
            decimals: Number(log.args.decimals),
            creator: getAddress(transaction.from),
            transactionHash: requireHash(log.transactionHash),
            logIndex: log.logIndex ?? -1,
            blockNumber: log.blockNumber ?? -1n,
            blockHash: requireHash(log.blockHash),
          };
        }),
      );
      return withCreators;
    },
    readTokenIdentity: async (token) => {
      const [name, symbol, decimals] = await Promise.all([
        client.readContract({ address: token, abi: ib20AssetAbi, functionName: "name" }),
        client.readContract({ address: token, abi: ib20AssetAbi, functionName: "symbol" }),
        client.readContract({ address: token, abi: ib20AssetAbi, functionName: "decimals" }),
      ]);
      return { name, symbol, decimals: Number(decimals) };
    },
    readIsInitializedB20: async (factory, token) => {
      const [isB20, isInitialized] = await Promise.all([
        client.readContract({ address: factory, abi: b20FactoryAbi, functionName: "isB20", args: [token] }),
        client.readContract({
          address: factory,
          abi: b20FactoryAbi,
          functionName: "isB20Initialized",
          args: [token],
        }),
      ]);
      return isB20 && isInitialized;
    },
    readTotalEscrowed: (vault, stock, blockNumber) =>
      client.readContract({
        address: vault,
        abi: sowmorrowVaultAbi,
        functionName: "totalEscrowed",
        blockNumber,
        args: [stock],
      }),
    readTokenBalance: (token, holder, blockNumber) =>
      client.readContract({
        address: token,
        abi: ib20AssetAbi,
        functionName: "balanceOf",
        blockNumber,
        args: [holder],
      }),
  };
}
