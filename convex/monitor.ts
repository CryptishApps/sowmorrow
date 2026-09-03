import { getAddress } from "viem";
import type { Address } from "viem";
import { makeFunctionReference } from "convex/server";
import { internalAction } from "./_generated/server";
import { configuredDeployment } from "./deployment";
import type { BlockRef } from "./rpc";

const listMonitoredStocksReference = makeFunctionReference<"query">("catalog:listMonitoredStocks");
const getCursorReference = makeFunctionReference<"query">("indexer:getCursor");
const recordMonitorSignalReference = makeFunctionReference<"mutation">("observability:recordMonitorSignal");
const recordSyncRunReference = makeFunctionReference<"mutation">("observability:recordSyncRun");

const MAX_MONITORED_STOCKS = 50;

type MonitoredStock = { addressLower: string; addressChecksum: string; symbol: string };
type Cursor = { lastCommittedBlock?: number };

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function safeNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("unsafe-number");
  return result;
}

export const checkVaultSolvencyAndLag = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = nowSeconds();
    const deployment = configuredDeployment();
    if (!deployment) return { operation: "not_configured" as const };
    const rpc = deployment.primary;

    let safeHead: BlockRef;
    try {
      safeHead = await rpc.getSafeBlock();
    } catch {
      await ctx.runMutation(recordSyncRunReference, {
        pipeline: "solvency-monitor",
        chainId: deployment.chainId,
        contractAddressLower: deployment.vaultAddressLower,
        startedAt,
        endedAt: nowSeconds(),
        outcome: "failed",
        errorCode: "rpc_failure",
      });
      return { operation: "rpc_failure" as const };
    }
    const safeHeadBlock = safeNumber(safeHead.number);

    const stocks = (await ctx.runQuery(listMonitoredStocksReference, {
      chainId: deployment.chainId,
      limit: MAX_MONITORED_STOCKS,
    })) as MonitoredStock[];

    let healthy = 0;
    let insolvent = 0;
    let unreadable = 0;
    for (const stock of stocks) {
      let token: Address;
      try {
        token = getAddress(stock.addressChecksum);
      } catch {
        unreadable += 1;
        continue;
      }
      let totalEscrowed: bigint;
      let vaultBalance: bigint;
      try {
        [totalEscrowed, vaultBalance] = await Promise.all([
          rpc.readTotalEscrowed(deployment.vaultAddress, token),
          rpc.readTokenBalance(token, deployment.vaultAddress),
        ]);
      } catch {
        unreadable += 1;
        continue;
      }
      const status = vaultBalance < totalEscrowed ? ("insolvent" as const) : ("healthy" as const);
      if (status === "insolvent") insolvent += 1;
      else healthy += 1;
      await ctx.runMutation(recordMonitorSignalReference, {
        chainId: deployment.chainId,
        vaultAddressLower: deployment.vaultAddressLower,
        observedAt: nowSeconds(),
        signal: {
          kind: "solvency",
          stockLower: stock.addressLower,
          totalEscrowedDecimal: totalEscrowed.toString(),
          vaultBalanceDecimal: vaultBalance.toString(),
          status,
        },
      });
    }

    const cursor = (await ctx.runQuery(getCursorReference, {
      pipeline: "vault-events",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
    })) as Cursor | null;
    const cursorBlock = cursor?.lastCommittedBlock ?? deployment.deploymentBlock;
    await ctx.runMutation(recordMonitorSignalReference, {
      chainId: deployment.chainId,
      vaultAddressLower: deployment.vaultAddressLower,
      observedAt: nowSeconds(),
      signal: {
        kind: "lag",
        safeHeadBlock,
        cursorBlock,
        lagBlocks: Math.max(safeHeadBlock - cursorBlock, 0),
      },
    });

    await ctx.runMutation(recordSyncRunReference, {
      pipeline: "solvency-monitor",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
      startedAt,
      endedAt: nowSeconds(),
      safeHeadBlock,
      outcome: "completed",
    });
    return { operation: "checked" as const, healthy, insolvent, unreadable, safeHeadBlock, cursorBlock };
  },
});
