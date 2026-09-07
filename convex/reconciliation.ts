import { decodeEventLog, getAddress } from "viem";
import type { Address, Hash, Hex } from "viem";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { sowmorrowVaultAbi } from "../lib/contracts/generated";
import type { ActionCtx } from "./_generated/server";
import { internalAction } from "./_generated/server";
import { configuredDeployment, rangeBackfillEnabled } from "./deployment";
import type { ConfiguredDeployment } from "./deployment";
import { createChainRpc, primaryRpcUrl } from "./rpc";
import type { BlockRef, ChainReceipt, ChainRpc, VaultEventLog } from "./rpc";

const reconcileDeliveryReference = makeFunctionReference<"action">("reconciliation:reconcileDelivery");
const claimDeliveryReference = makeFunctionReference<"mutation">("webhooks:claimDelivery");
const failDeliveryReference = makeFunctionReference<"mutation">("webhooks:failDelivery");
const completeDeliveryReference = makeFunctionReference<"mutation">("webhooks:completeDelivery");
const listDueDeliveriesReference = makeFunctionReference<"query">("webhooks:listDueDeliveries");
const applyVaultLogReference = makeFunctionReference<"mutation">("events:applyCanonicalVaultLog");
const listTipEventsReference = makeFunctionReference<"query">("events:listTipEventsThroughBlock");
const listEventsAboveBlockReference = makeFunctionReference<"query">("events:listEventsAboveBlock");
const setEventCanonicalityReference = makeFunctionReference<"mutation">("events:setEventCanonicality");
const getCursorReference = makeFunctionReference<"query">("indexer:getCursor");
const initializeCursorReference = makeFunctionReference<"mutation">("indexer:initializeCursor");
const advanceCursorReference = makeFunctionReference<"mutation">("indexer:advanceCursor");
const rewindCursorReference = makeFunctionReference<"mutation">("indexer:rewindCursor");
const haltCursorReference = makeFunctionReference<"mutation">("indexer:haltCursor");
const recordDeploymentReference = makeFunctionReference<"mutation">("indexer:recordActiveDeployment");
const recordSyncRunReference = makeFunctionReference<"mutation">("observability:recordSyncRun");
const recordMonitorSignalReference = makeFunctionReference<"mutation">("observability:recordMonitorSignal");

const MAX_RANGE_BLOCKS = 1_999n;
const MAX_TIP_EVENTS = 500;
const MAX_ORPHAN_BATCH = 500;

type DeliveryFailureCode =
  | "configuration"
  | "rpc_failure"
  | "receipt_failed"
  | "receipt_mismatch"
  | "log_missing"
  | "log_decode_failed"
  | "event_conflict";

type SyncErrorCode =
  | "rpc_failure"
  | "receipt_failed"
  | "receipt_mismatch"
  | "log_decode_failed"
  | "projection_failure"
  | "cursor_conflict"
  | "reorg_beyond_checkpoints"
  | "missing_block_hash"
  | "provider_disagreement"
  | "unsafe_number";

type SyncOutcome =
  | "indexed"
  | "caught_up"
  | "promoted_tip_events"
  | "rewound"
  | "halted"
  | "not_configured"
  | "chain_mismatch"
  | "provider_split"
  | "failed"
  | "completed";

type Delivery = {
  deliveryId: string;
  processingStatus: "processing";
  chainId: number;
  vaultAddressLower: string;
  transactionHashLower: string;
  logIndex: number;
  blockNumber: number;
  eventName: "GiftCreated" | "GiftClaimed";
};

type Checkpoint = { blockNumber: number; blockHashLower: string };

type Cursor = {
  nextBlock: number;
  lastCommittedBlock?: number;
  lastCommittedBlockHashLower?: string;
  checkpoints: Checkpoint[];
  state: "active" | "halted";
};

type TipEvent = {
  transactionHashLower: string;
  logIndex: number;
  blockNumber: number;
  blockHashLower: string;
};

type EventMetadata = {
  chainId: number;
  vaultAddressLower: string;
  transactionHash: Hash;
  transactionIndex: number;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hash;
  canonicality: "tip" | "safe";
  source: "webhook" | "reconciler";
};

type DecodedGiftCreated = {
  giftId: bigint;
  sender: Address;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
  noteHash: Hex;
};

type DecodedGiftClaimed = {
  giftId: bigint;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
};

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function safeNumber(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("unsafe-number");
  return result;
}

function eventTopics(topics: readonly Hex[]) {
  return topics as [] | [Hex, ...Hex[]];
}

function eventInput(
  eventName: "GiftCreated" | "GiftClaimed",
  args: DecodedGiftCreated | DecodedGiftClaimed,
  metadata: EventMetadata,
) {
  const common = {
    chainId: metadata.chainId,
    vaultAddressLower: metadata.vaultAddressLower,
    transactionHashLower: metadata.transactionHash.toLowerCase(),
    transactionIndex: metadata.transactionIndex,
    logIndex: metadata.logIndex,
    blockNumber: safeNumber(metadata.blockNumber),
    blockHashLower: metadata.blockHash.toLowerCase(),
    eventName,
    giftIdDecimal: args.giftId.toString(),
    recipientLower: getAddress(args.recipient).toLowerCase(),
    stockLower: getAddress(args.stock).toLowerCase(),
    amountRawDecimal: args.amountRaw.toString(),
    canonicality: metadata.canonicality,
    source: metadata.source,
    observedAt: nowSeconds(),
  };
  if (eventName === "GiftCreated") {
    const created = args as DecodedGiftCreated;
    return {
      ...common,
      eventName,
      senderLower: getAddress(created.sender).toLowerCase(),
      unlockAt: safeNumber(created.unlockAt),
      noteHashLower: created.noteHash.toLowerCase(),
    };
  }
  return { ...common, eventName };
}

async function failDelivery(
  ctx: ActionCtx,
  deliveryId: string,
  failureCode: DeliveryFailureCode,
  retryable = false,
) {
  const result = (await ctx.runMutation(failDeliveryReference, {
    deliveryId,
    failureCode,
    retryable,
    now: nowSeconds(),
  })) as { operation: "retry"; delaySeconds: number } | { operation: "failed" | "missing" };
  if (result.operation === "retry") {
    await ctx.scheduler.runAfter(result.delaySeconds * 1_000, reconcileDeliveryReference, {
      deliveryId,
    });
    return { operation: "retry_scheduled" as const, failureCode };
  }
  return { operation: "failed" as const, failureCode };
}

function receiptProvesLog(
  receipt: ChainReceipt,
  vaultAddressLower: string,
  log: { logIndex: number; blockNumber: bigint; blockHash: Hash; topics: readonly Hex[]; data: Hex },
): { ok: true } | { ok: false; errorCode: SyncErrorCode } {
  if (receipt.status !== "success") return { ok: false, errorCode: "receipt_failed" };
  if (
    receipt.blockNumber !== log.blockNumber ||
    receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase()
  ) {
    return { ok: false, errorCode: "receipt_mismatch" };
  }
  const proven = receipt.logs.find(
    (candidate) =>
      candidate.logIndex === log.logIndex && candidate.address.toLowerCase() === vaultAddressLower,
  );
  if (!proven) return { ok: false, errorCode: "receipt_mismatch" };
  if (
    proven.data !== log.data ||
    proven.topics.length !== log.topics.length ||
    proven.topics.some((topic, index) => topic !== log.topics[index])
  ) {
    return { ok: false, errorCode: "receipt_mismatch" };
  }
  return { ok: true };
}

export const reconcileDelivery = internalAction({
  args: { deliveryId: v.string() },
  handler: async (ctx, { deliveryId }) => {
    const claim = (await ctx.runMutation(claimDeliveryReference, {
      deliveryId,
      now: nowSeconds(),
    })) as
      | { operation: "claimed"; delivery: Delivery }
      | { operation: "deferred" | "leased"; retryAfterSeconds: number }
      | { operation: "missing" | "already_processed" | "exhausted" };
    if (claim.operation === "deferred" || claim.operation === "leased") {
      await ctx.scheduler.runAfter(claim.retryAfterSeconds * 1_000, reconcileDeliveryReference, {
        deliveryId,
      });
      return { operation: claim.operation };
    }
    if (claim.operation === "exhausted") return { operation: "exhausted" as const };
    if (claim.operation !== "claimed") return { operation: "already_processed" as const };
    const delivery = claim.delivery;

    const url = primaryRpcUrl(delivery.chainId);
    if (!url) return failDelivery(ctx, deliveryId, "configuration");
    const rpc = createChainRpc(delivery.chainId, url);

    try {
      if ((await rpc.getChainId()) !== delivery.chainId)
        return failDelivery(ctx, deliveryId, "receipt_mismatch");
    } catch {
      return failDelivery(ctx, deliveryId, "rpc_failure", true);
    }

    let receipt: ChainReceipt;
    try {
      receipt = await rpc.getTransactionReceipt(delivery.transactionHashLower as Hash);
    } catch {
      return failDelivery(ctx, deliveryId, "rpc_failure", true);
    }
    if (receipt.status !== "success") return failDelivery(ctx, deliveryId, "receipt_failed");
    if (safeNumber(receipt.blockNumber) !== delivery.blockNumber) {
      return failDelivery(ctx, deliveryId, "receipt_mismatch");
    }

    const log = receipt.logs.find(
      (candidate) =>
        candidate.logIndex === delivery.logIndex &&
        candidate.address.toLowerCase() === delivery.vaultAddressLower,
    );
    if (!log) return failDelivery(ctx, deliveryId, "log_missing");

    let decoded: ReturnType<typeof decodeEventLog<typeof sowmorrowVaultAbi>>;
    try {
      decoded = decodeEventLog({
        abi: sowmorrowVaultAbi,
        data: log.data,
        topics: eventTopics(log.topics),
        strict: true,
      });
    } catch {
      return failDelivery(ctx, deliveryId, "log_decode_failed");
    }
    if (decoded.eventName !== delivery.eventName) return failDelivery(ctx, deliveryId, "receipt_mismatch");

    let canonicality: "tip" | "safe";
    try {
      const [eventBlock, safeBlock] = await Promise.all([
        rpc.getBlock(receipt.blockNumber),
        rpc.getSafeBlock(),
      ]);
      if (eventBlock === null || eventBlock.hashLower !== receipt.blockHash.toLowerCase()) {
        return failDelivery(ctx, deliveryId, "receipt_mismatch");
      }
      canonicality = receipt.blockNumber <= safeBlock.number ? "safe" : "tip";
    } catch {
      return failDelivery(ctx, deliveryId, "rpc_failure", true);
    }

    let result: { operation: string };
    try {
      result = await ctx.runMutation(
        applyVaultLogReference,
        eventInput(delivery.eventName, decoded.args as DecodedGiftCreated | DecodedGiftClaimed, {
          chainId: delivery.chainId,
          vaultAddressLower: delivery.vaultAddressLower,
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex,
          logIndex: delivery.logIndex,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          canonicality,
          source: "webhook",
        }),
      );
    } catch {
      return failDelivery(ctx, deliveryId, "event_conflict");
    }

    const eventKey = `${delivery.chainId}:${delivery.vaultAddressLower}:${delivery.transactionHashLower}:${delivery.logIndex}`;
    await ctx.runMutation(completeDeliveryReference, {
      deliveryId,
      eventKey,
      duplicate: result.operation === "duplicate",
    });
    return { operation: result.operation };
  },
});

export const retryDueDeliveries = internalAction({
  args: {},
  handler: async (ctx) => {
    const due = (await ctx.runQuery(listDueDeliveriesReference, {
      now: nowSeconds(),
      limit: 100,
    })) as Array<{ deliveryId: string }>;
    for (const delivery of due) {
      await ctx.scheduler.runAfter(0, reconcileDeliveryReference, {
        deliveryId: delivery.deliveryId,
      });
    }
    return { scheduled: due.length };
  },
});

async function findCommonAncestor(rpc: ChainRpc, checkpoints: Checkpoint[], belowBlock: number) {
  const candidates = checkpoints
    .filter((entry) => entry.blockNumber < belowBlock)
    .sort((left, right) => right.blockNumber - left.blockNumber);
  for (const candidate of candidates) {
    const block = await rpc.getBlock(BigInt(candidate.blockNumber));
    if (block !== null && block.hashLower === candidate.blockHashLower) return candidate;
  }
  return null;
}

async function orphanEventsAbove(
  ctx: ActionCtx,
  chainId: number,
  vaultAddressLower: string,
  aboveBlock: number,
  requireHalted = false,
) {
  const events = (await ctx.runQuery(listEventsAboveBlockReference, {
    chainId,
    vaultAddressLower,
    aboveBlock,
    limit: MAX_ORPHAN_BATCH,
  })) as TipEvent[];
  for (const event of events) {
    const result = (await ctx.runMutation(setEventCanonicalityReference, {
      ...(requireHalted ? { requireHalted: true } : {}),
      chainId,
      vaultAddressLower,
      transactionHashLower: event.transactionHashLower,
      logIndex: event.logIndex,
      blockHashLower: event.blockHashLower,
      canonicality: "orphaned",
      observedAt: nowSeconds(),
    })) as { operation: string };
    if (result.operation === "recovery_finished") return { orphaned: 0, complete: false };
  }
  return { orphaned: events.length, complete: events.length < MAX_ORPHAN_BATCH };
}

type RunRecord = {
  startedAt: number;
  outcome: SyncOutcome;
  errorCode?: SyncErrorCode;
  fromBlock?: number;
  toBlock?: number;
  safeHeadBlock?: number;
  eventsApplied?: number;
};

async function recordRun(ctx: ActionCtx, deployment: ConfiguredDeployment, run: RunRecord) {
  await ctx.runMutation(recordSyncRunReference, {
    pipeline: "vault-events",
    chainId: deployment.chainId,
    contractAddressLower: deployment.vaultAddressLower,
    startedAt: run.startedAt,
    endedAt: nowSeconds(),
    fromBlock: run.fromBlock,
    toBlock: run.toBlock,
    safeHeadBlock: run.safeHeadBlock,
    eventsApplied: run.eventsApplied,
    outcome: run.outcome,
    errorCode: run.errorCode,
  });
}

async function promoteTipEvents(
  ctx: ActionCtx,
  deployment: ConfiguredDeployment,
  rpc: ChainRpc,
  safeHead: BlockRef,
) {
  const tipEvents = (await ctx.runQuery(listTipEventsReference, {
    chainId: deployment.chainId,
    vaultAddressLower: deployment.vaultAddressLower,
    throughBlock: safeNumber(safeHead.number),
    limit: MAX_TIP_EVENTS,
  })) as TipEvent[];
  const blocks = new Map<number, Promise<BlockRef | null>>();
  let promoted = 0;
  let orphaned = 0;
  for (const event of tipEvents) {
    let block = blocks.get(event.blockNumber);
    if (!block) {
      block = rpc.getBlock(BigInt(event.blockNumber));
      blocks.set(event.blockNumber, block);
    }
    const canonicalHash = (await block)?.hashLower;
    const canonicality = canonicalHash === event.blockHashLower ? "safe" : "orphaned";
    if (canonicality === "safe") promoted += 1;
    else orphaned += 1;
    await ctx.runMutation(setEventCanonicalityReference, {
      chainId: deployment.chainId,
      vaultAddressLower: deployment.vaultAddressLower,
      transactionHashLower: event.transactionHashLower,
      logIndex: event.logIndex,
      blockHashLower: event.blockHashLower,
      canonicality,
      observedAt: nowSeconds(),
    });
  }
  return { promoted, orphaned };
}

export const reconcileConfiguredVault = internalAction({
  args: {},
  handler: async (ctx) => {
    const startedAt = nowSeconds();
    const deployment = configuredDeployment();
    if (!deployment) return { operation: "not_configured" as const };
    const rpc = deployment.primary;
    const vaultAddressLower = deployment.vaultAddressLower;

    let safeHead: BlockRef;
    try {
      if ((await rpc.getChainId()) !== deployment.chainId) {
        await recordRun(ctx, deployment, { startedAt, outcome: "chain_mismatch" });
        return { operation: "chain_mismatch" as const };
      }
      safeHead = await rpc.getSafeBlock();
    } catch {
      await recordRun(ctx, deployment, { startedAt, outcome: "failed", errorCode: "rpc_failure" });
      return { operation: "rpc_failure" as const };
    }
    const safeHeadBlock = safeNumber(safeHead.number);

    if (deployment.secondary) {
      let secondaryBlock: BlockRef | null;
      try {
        secondaryBlock = await deployment.secondary.getBlock(safeHead.number);
      } catch {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: "rpc_failure",
          safeHeadBlock,
        });
        return { operation: "rpc_failure" as const };
      }
      if (secondaryBlock === null || secondaryBlock.hashLower !== safeHead.hashLower) {
        await ctx.runMutation(recordMonitorSignalReference, {
          chainId: deployment.chainId,
          vaultAddressLower,
          observedAt: nowSeconds(),
          signal: {
            kind: "provider_split",
            blockNumber: safeHeadBlock,
            primaryBlockHashLower: safeHead.hashLower,
            secondaryBlockHashLower: secondaryBlock?.hashLower ?? "",
          },
        });
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "provider_split",
          errorCode: "provider_disagreement",
          safeHeadBlock,
        });
        return { operation: "provider_split" as const, blockNumber: safeHeadBlock };
      }
    }

    let cursor = (await ctx.runQuery(getCursorReference, {
      pipeline: "vault-events",
      chainId: deployment.chainId,
      contractAddressLower: vaultAddressLower,
    })) as Cursor | null;
    if (!cursor) {
      cursor = (await ctx.runMutation(initializeCursorReference, {
        pipeline: "vault-events",
        chainId: deployment.chainId,
        contractAddressLower: vaultAddressLower,
        deploymentBlock: deployment.deploymentBlock,
        now: nowSeconds(),
      })) as Cursor;
    }
    if (cursor.state !== "active") {
      await recordRun(ctx, deployment, { startedAt, outcome: "halted", safeHeadBlock });
      return { operation: "halted" as const };
    }

    let tipResult: { promoted: number; orphaned: number };
    try {
      tipResult = await promoteTipEvents(ctx, deployment, rpc, safeHead);
    } catch {
      await recordRun(ctx, deployment, {
        startedAt,
        outcome: "failed",
        errorCode: "projection_failure",
        safeHeadBlock,
      });
      return { operation: "tip_promotion_failure" as const };
    }

    if (cursor.lastCommittedBlock !== undefined && cursor.lastCommittedBlockHashLower !== undefined) {
      let committed: BlockRef | null;
      try {
        committed = await rpc.getBlock(BigInt(cursor.lastCommittedBlock));
      } catch {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: "rpc_failure",
          safeHeadBlock,
        });
        return { operation: "rpc_failure" as const };
      }
      if (committed === null || committed.hashLower !== cursor.lastCommittedBlockHashLower) {
        let ancestor: Checkpoint | null;
        try {
          ancestor = await findCommonAncestor(rpc, cursor.checkpoints, cursor.lastCommittedBlock);
        } catch {
          await recordRun(ctx, deployment, {
            startedAt,
            outcome: "failed",
            errorCode: "rpc_failure",
            safeHeadBlock,
          });
          return { operation: "rpc_failure" as const };
        }
        if (ancestor === null) {
          await ctx.runMutation(haltCursorReference, {
            pipeline: "vault-events",
            chainId: deployment.chainId,
            contractAddressLower: vaultAddressLower,
            failureCode: "reorg_beyond_checkpoints",
            now: nowSeconds(),
          });
          await recordRun(ctx, deployment, {
            startedAt,
            outcome: "halted",
            errorCode: "reorg_beyond_checkpoints",
            safeHeadBlock,
          });
          return { operation: "halted_beyond_checkpoints" as const };
        }
        const orphanedEvents = await orphanEventsAbove(
          ctx,
          deployment.chainId,
          vaultAddressLower,
          ancestor.blockNumber,
        );
        if (!orphanedEvents.complete)
          return { operation: "cleanup_pending" as const, orphanedEvents: orphanedEvents.orphaned };
        await ctx.runMutation(rewindCursorReference, {
          pipeline: "vault-events",
          chainId: deployment.chainId,
          contractAddressLower: vaultAddressLower,
          ancestorBlock: ancestor.blockNumber,
          ancestorBlockHashLower: ancestor.blockHashLower,
          now: nowSeconds(),
        });
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "rewound",
          toBlock: ancestor.blockNumber,
          safeHeadBlock,
        });
        return {
          operation: "rewound" as const,
          ancestorBlock: ancestor.blockNumber,
          orphanedEvents: orphanedEvents.orphaned,
        };
      }
    }

    if (!rangeBackfillEnabled()) {
      await recordActiveDeployment(ctx, deployment);
      await recordRun(ctx, deployment, { startedAt, outcome: "promoted_tip_events", safeHeadBlock });
      return { operation: "tip_only" as const, ...tipResult };
    }

    const fromBlock = BigInt(cursor.nextBlock);
    const toBlock =
      fromBlock + MAX_RANGE_BLOCKS < safeHead.number ? fromBlock + MAX_RANGE_BLOCKS : safeHead.number;
    if (fromBlock > toBlock) {
      await recordActiveDeployment(ctx, deployment);
      await recordRun(ctx, deployment, { startedAt, outcome: "caught_up", safeHeadBlock });
      return { operation: "caught_up" as const };
    }

    let logs: VaultEventLog[];
    try {
      logs = await rpc.getVaultEvents({ vault: deployment.vaultAddress, fromBlock, toBlock });
    } catch {
      await recordRun(ctx, deployment, {
        startedAt,
        outcome: "failed",
        errorCode: "rpc_failure",
        fromBlock: safeNumber(fromBlock),
        toBlock: safeNumber(toBlock),
        safeHeadBlock,
      });
      return { operation: "rpc_failure" as const };
    }

    const ordered = [...logs].sort((left, right) => {
      const blockOrder = Number(left.blockNumber - right.blockNumber);
      if (blockOrder !== 0) return blockOrder;
      const transactionOrder = left.transactionIndex - right.transactionIndex;
      return transactionOrder !== 0 ? transactionOrder : left.logIndex - right.logIndex;
    });

    const receipts = new Map<string, ChainReceipt>();
    for (const log of ordered) {
      const key = log.transactionHash.toLowerCase();
      let receipt = receipts.get(key);
      if (!receipt) {
        try {
          receipt = await rpc.getTransactionReceipt(log.transactionHash);
        } catch {
          await recordRun(ctx, deployment, {
            startedAt,
            outcome: "failed",
            errorCode: "rpc_failure",
            fromBlock: safeNumber(fromBlock),
            toBlock: safeNumber(toBlock),
            safeHeadBlock,
          });
          return { operation: "rpc_failure" as const };
        }
        receipts.set(key, receipt);
      }
      const proof = receiptProvesLog(receipt, vaultAddressLower, log);
      if (!proof.ok) {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: proof.errorCode,
          fromBlock: safeNumber(fromBlock),
          toBlock: safeNumber(toBlock),
          safeHeadBlock,
        });
        return { operation: "log_unproven" as const, errorCode: proof.errorCode };
      }
    }

    let applied = 0;
    for (const log of ordered) {
      const receipt = receipts.get(log.transactionHash.toLowerCase());
      if (!receipt) continue;
      let decoded: ReturnType<typeof decodeEventLog<typeof sowmorrowVaultAbi>>;
      try {
        decoded = decodeEventLog({
          abi: sowmorrowVaultAbi,
          data: log.data,
          topics: eventTopics(log.topics),
          strict: true,
        });
      } catch {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: "log_decode_failed",
          fromBlock: safeNumber(fromBlock),
          toBlock: safeNumber(toBlock),
          safeHeadBlock,
        });
        return { operation: "log_decode_failed" as const };
      }
      if (decoded.eventName !== log.eventName) {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: "receipt_mismatch",
          fromBlock: safeNumber(fromBlock),
          toBlock: safeNumber(toBlock),
          safeHeadBlock,
        });
        return { operation: "log_unproven" as const, errorCode: "receipt_mismatch" as const };
      }
      try {
        await ctx.runMutation(
          applyVaultLogReference,
          eventInput(log.eventName, decoded.args as DecodedGiftCreated | DecodedGiftClaimed, {
            chainId: deployment.chainId,
            vaultAddressLower,
            transactionHash: log.transactionHash,
            transactionIndex: log.transactionIndex,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            canonicality: "safe",
            source: "reconciler",
          }),
        );
      } catch {
        await recordRun(ctx, deployment, {
          startedAt,
          outcome: "failed",
          errorCode: "projection_failure",
          fromBlock: safeNumber(fromBlock),
          toBlock: safeNumber(toBlock),
          safeHeadBlock,
        });
        return { operation: "projection_failure" as const };
      }
      applied += 1;
    }

    let endBlock: BlockRef | null;
    try {
      endBlock = await rpc.getBlock(toBlock);
    } catch {
      endBlock = null;
    }
    if (endBlock === null) {
      await recordRun(ctx, deployment, {
        startedAt,
        outcome: "failed",
        errorCode: "missing_block_hash",
        fromBlock: safeNumber(fromBlock),
        toBlock: safeNumber(toBlock),
        safeHeadBlock,
        eventsApplied: applied,
      });
      return { operation: "missing_end_block_hash" as const };
    }

    try {
      await ctx.runMutation(advanceCursorReference, {
        pipeline: "vault-events",
        chainId: deployment.chainId,
        contractAddressLower: vaultAddressLower,
        expectedNextBlock: cursor.nextBlock,
        committedBlock: safeNumber(toBlock),
        committedBlockHashLower: endBlock.hashLower,
        now: nowSeconds(),
      });
    } catch {
      await recordRun(ctx, deployment, {
        startedAt,
        outcome: "failed",
        errorCode: "cursor_conflict",
        fromBlock: safeNumber(fromBlock),
        toBlock: safeNumber(toBlock),
        safeHeadBlock,
        eventsApplied: applied,
      });
      return { operation: "cursor_conflict" as const };
    }

    await recordActiveDeployment(ctx, deployment);
    await recordRun(ctx, deployment, {
      startedAt,
      outcome: "indexed",
      fromBlock: safeNumber(fromBlock),
      toBlock: safeNumber(toBlock),
      safeHeadBlock,
      eventsApplied: applied,
    });
    return { operation: "indexed" as const, events: applied, throughBlock: safeNumber(toBlock) };
  },
});

async function recordActiveDeployment(ctx: ActionCtx, deployment: ConfiguredDeployment) {
  await ctx.runMutation(recordDeploymentReference, {
    chainId: deployment.chainId,
    network: deployment.network,
    vaultAddressChecksum: deployment.vaultAddressChecksum,
    deploymentBlock: deployment.deploymentBlock,
    now: nowSeconds(),
  });
}

export const repairHaltedCursor = internalAction({
  args: {
    resetToBlock: v.number(),
    resetToBlockHashLower: v.string(),
    operator: v.string(),
  },
  handler: async (ctx, { resetToBlock, resetToBlockHashLower, operator }) => {
    const startedAt = nowSeconds();
    const deployment = configuredDeployment();
    if (!deployment) return { operation: "not_configured" as const };

    let block: BlockRef | null;
    try {
      block = await deployment.primary.getBlock(BigInt(resetToBlock));
    } catch {
      return { operation: "rpc_failure" as const };
    }
    if (block === null || block.hashLower !== resetToBlockHashLower) {
      return { operation: "reset_hash_mismatch" as const };
    }

    const cursor = (await ctx.runQuery(getCursorReference, {
      pipeline: "vault-events",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
    })) as Cursor | null;
    if (!cursor) return { operation: "missing" as const };
    if (cursor.state !== "halted") return { operation: "not_halted" as const };
    const deploymentBoundary = resetToBlock === deployment.deploymentBlock - 1;
    if (
      !deploymentBoundary &&
      !cursor.checkpoints.some(
        (checkpoint) =>
          checkpoint.blockNumber === resetToBlock && checkpoint.blockHashLower === resetToBlockHashLower,
      )
    ) {
      return { operation: "unknown_checkpoint" as const };
    }
    const begin = (await ctx.runMutation(makeFunctionReference<"mutation">("indexer:beginHaltedRepair"), {
      pipeline: "vault-events",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
      resetToBlock,
    })) as { operation: "ready" | "missing" | "not_halted" | "repair_boundary_conflict" };
    if (begin.operation !== "ready") return begin;
    const orphanedEvents = await orphanEventsAbove(
      ctx,
      deployment.chainId,
      deployment.vaultAddressLower,
      resetToBlock,
      true,
    );
    if (!orphanedEvents.complete)
      return { operation: "cleanup_pending" as const, orphanedEvents: orphanedEvents.orphaned };
    const confirmedBlock = await deployment.primary.getBlock(BigInt(resetToBlock));
    if (confirmedBlock?.hashLower !== resetToBlockHashLower)
      return { operation: "reset_hash_mismatch" as const };
    const result = (await ctx.runMutation(makeFunctionReference<"mutation">("indexer:resumeHaltedCursor"), {
      pipeline: "vault-events",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
      resetToBlock,
      resetToBlockHashLower,
      operator,
      now: nowSeconds(),
    })) as {
      operation: "resumed" | "missing" | "not_halted" | "repair_boundary_conflict" | "cleanup_pending";
    };
    if (result.operation !== "resumed") return { operation: result.operation };

    await ctx.runMutation(recordSyncRunReference, {
      pipeline: "operator-repair",
      chainId: deployment.chainId,
      contractAddressLower: deployment.vaultAddressLower,
      startedAt,
      endedAt: nowSeconds(),
      toBlock: resetToBlock,
      outcome: "completed",
      operator,
    });
    return { operation: "resumed" as const, orphanedEvents: orphanedEvents.orphaned };
  },
});
