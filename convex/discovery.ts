import { getAddress } from "viem";
import type { Address } from "viem";
import { makeFunctionReference } from "convex/server";
import { internalAction } from "./_generated/server";
import catalogJson from "../data/reviewed-stock-catalog.base-mainnet.json";
import { configuredDeployment } from "./deployment";
import { B20_ASSET_VARIANT } from "./rpc";
import type { BlockRef, FactoryCreationLog } from "./rpc";

const getCursorReference = makeFunctionReference<"query">("indexer:getCursor");
const initializeCursorReference = makeFunctionReference<"mutation">("indexer:initializeCursor");
const advanceCursorReference = makeFunctionReference<"mutation">("indexer:advanceCursor");
const quarantineCandidateReference = makeFunctionReference<"mutation">("catalog:quarantineCandidate");
const recordSyncRunReference = makeFunctionReference<"mutation">("observability:recordSyncRun");

export const b20FactoryAddress: Address = getAddress(catalogJson.b20.factoryAddress);

const MAX_RANGE_BLOCKS = 1_999n;

type Cursor = { nextBlock: number; state: "active" | "halted" };

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function safeNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("unsafe-number");
  return result;
}

function discoveryStartBlock(deploymentBlock: number) {
  const configured = Number(process.env.SOWMORROW_B20_FACTORY_START_BLOCK);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : deploymentBlock;
}

export const scanFactoryCandidates = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = nowSeconds();
    const deployment = configuredDeployment();
    if (!deployment) return { operation: "not_configured" as const };
    const rpc = deployment.primary;
    const factoryAddressLower = b20FactoryAddress.toLowerCase();

    const finish = async (
      outcome: "caught_up" | "halted" | "chain_mismatch" | "indexed" | "failed",
      extra: { fromBlock?: number; toBlock?: number; safeHeadBlock?: number; eventsApplied?: number } = {},
      errorCode?: "rpc_failure" | "cursor_conflict" | "missing_block_hash",
    ) => {
      await ctx.runMutation(recordSyncRunReference, {
        pipeline: "factory-candidates",
        chainId: deployment.chainId,
        contractAddressLower: factoryAddressLower,
        startedAt,
        endedAt: nowSeconds(),
        outcome,
        errorCode,
        ...extra,
      });
    };

    let safeHead: BlockRef;
    try {
      if ((await rpc.getChainId()) !== deployment.chainId) {
        await finish("chain_mismatch");
        return { operation: "chain_mismatch" as const };
      }
      safeHead = await rpc.getSafeBlock();
    } catch {
      await finish("failed", {}, "rpc_failure");
      return { operation: "rpc_failure" as const };
    }
    const safeHeadBlock = safeNumber(safeHead.number);

    let cursor = (await ctx.runQuery(getCursorReference, {
      pipeline: "factory-candidates",
      chainId: deployment.chainId,
      contractAddressLower: factoryAddressLower,
    })) as Cursor | null;
    if (!cursor) {
      cursor = (await ctx.runMutation(initializeCursorReference, {
        pipeline: "factory-candidates",
        chainId: deployment.chainId,
        contractAddressLower: factoryAddressLower,
        deploymentBlock: discoveryStartBlock(deployment.deploymentBlock),
        now: nowSeconds(),
      })) as Cursor;
    }
    if (cursor.state !== "active") {
      await finish("halted", { safeHeadBlock });
      return { operation: "halted" as const };
    }

    const fromBlock = BigInt(cursor.nextBlock);
    const toBlock =
      fromBlock + MAX_RANGE_BLOCKS < safeHead.number ? fromBlock + MAX_RANGE_BLOCKS : safeHead.number;
    if (fromBlock > toBlock) {
      await finish("caught_up", { safeHeadBlock });
      return { operation: "caught_up" as const };
    }

    let creations: FactoryCreationLog[];
    try {
      creations = await rpc.getFactoryCreations({
        factory: b20FactoryAddress,
        fromBlock,
        toBlock,
      });
    } catch {
      await finish(
        "failed",
        { fromBlock: safeNumber(fromBlock), toBlock: safeNumber(toBlock), safeHeadBlock },
        "rpc_failure",
      );
      return { operation: "rpc_failure" as const };
    }

    let quarantined = 0;
    let rejected = 0;
    for (const creation of creations) {
      if (creation.variant !== B20_ASSET_VARIANT) {
        rejected += 1;
        continue;
      }
      let block: BlockRef | null;
      let initialized: boolean;
      let identity: { name: string; symbol: string; decimals: number };
      try {
        block = await rpc.getBlock(creation.blockNumber);
        initialized = await rpc.readIsInitializedB20(b20FactoryAddress, creation.token);
        identity = await rpc.readTokenIdentity(creation.token);
      } catch {
        await finish(
          "failed",
          { fromBlock: safeNumber(fromBlock), toBlock: safeNumber(toBlock), safeHeadBlock },
          "rpc_failure",
        );
        return { operation: "rpc_failure" as const };
      }
      if (block === null || block.hashLower !== creation.blockHash.toLowerCase() || !initialized) {
        rejected += 1;
        continue;
      }
      const result = (await ctx.runMutation(quarantineCandidateReference, {
        chainId: deployment.chainId,
        addressChecksum: creation.token,
        factoryAddressLower,
        creatorAddressLower: creation.creator.toLowerCase(),
        creationTxHashLower: creation.transactionHash.toLowerCase(),
        creationLogIndex: creation.logIndex,
        creationBlock: safeNumber(creation.blockNumber),
        creationBlockHashLower: creation.blockHash.toLowerCase(),
        observedName: identity.name,
        observedSymbol: identity.symbol,
        observedDecimals: identity.decimals,
        observedVariant: "asset",
        now: nowSeconds(),
      })) as { operation: "quarantined" | "seen_again" | "already_reviewed" };
      if (result.operation === "quarantined") quarantined += 1;
    }

    let endBlock: BlockRef | null;
    try {
      endBlock = await rpc.getBlock(toBlock);
    } catch {
      endBlock = null;
    }
    if (endBlock === null) {
      await finish(
        "failed",
        { fromBlock: safeNumber(fromBlock), toBlock: safeNumber(toBlock), safeHeadBlock },
        "missing_block_hash",
      );
      return { operation: "missing_end_block_hash" as const };
    }

    try {
      await ctx.runMutation(advanceCursorReference, {
        pipeline: "factory-candidates",
        chainId: deployment.chainId,
        contractAddressLower: factoryAddressLower,
        expectedNextBlock: cursor.nextBlock,
        committedBlock: safeNumber(toBlock),
        committedBlockHashLower: endBlock.hashLower,
        now: nowSeconds(),
      });
    } catch {
      await finish(
        "failed",
        { fromBlock: safeNumber(fromBlock), toBlock: safeNumber(toBlock), safeHeadBlock },
        "cursor_conflict",
      );
      return { operation: "cursor_conflict" as const };
    }

    await finish("indexed", {
      fromBlock: safeNumber(fromBlock),
      toBlock: safeNumber(toBlock),
      safeHeadBlock,
      eventsApplied: quarantined,
    });
    return { operation: "scanned" as const, quarantined, rejected, throughBlock: safeNumber(toBlock) };
  },
});
