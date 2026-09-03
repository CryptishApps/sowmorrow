"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import {
  useConnect,
  useConnection,
  useConnectors,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { formatUnits } from "viem";
import type { Address, Hash } from "viem";
import { claimEntrance, entranceItem, useEntranceSettled } from "@/components/entrance";
import type { Entrance } from "@/components/entrance";
import {
  ConnectorPicker,
  friendlyError,
  MirrorNotice,
  ProgressNotice,
  shortAddress,
  Spinner,
  StockDot,
  transactionLink,
} from "@/components/gift-chrome";
import type { AppDeployment } from "@/lib/contracts/config";
import { mapFlowError, revertedErrorName } from "@/lib/contracts/errors";
import { executeClaim } from "@/lib/contracts/flows";
import type { ClaimPhase } from "@/lib/contracts/flows";
import { ib20Abi, ib20AssetAbi, sowmorrowVaultAbi } from "@/lib/contracts/generated";
import { decodePendingClaim, encodePendingClaim, pendingClaimStorageKey } from "@/lib/contracts/pending";
import type { PendingClaimSubmission } from "@/lib/contracts/pending";
import { proveGiftClaimed } from "@/lib/contracts/receipts";
import { mirrorApi, mirrorConfigured } from "@/lib/convex/api";
import { useMirrorQuery } from "@/lib/convex/provider";
import {
  BLOCK_PAGE_SPAN,
  chunkedCalls,
  classifyGift,
  compareRows,
  DEFAULT_MAX_BATCH,
  groupByStock,
  knownCounterparties,
  limitSelection,
  LogRangeError,
  MAX_LOGS_PER_PAGE,
  MULTICALL_CHUNK,
  partitionSmallGifts,
  readLogRange,
  smallAmountThresholds,
} from "@/lib/web3/inbox";
import type { ExclusionReason, GiftRow, GiftRowState, InboxGift, MirrorGift } from "@/lib/web3/inbox";
import { readReceiptWithFallback, secondaryPublicClient } from "@/lib/web3/secondary";
import { stocks } from "@/lib/stocks";

type Props = { deployment: AppDeployment; entrance: Entrance; onClaim: () => void };

type GiftStruct = {
  sender: Address;
  recipient: Address;
  stock: Address;
  unlockAt: bigint;
  status: number;
  amountRaw: bigint;
};

type ReadResult<value> = { status: "success"; result: value } | { status: "failure" };

type InboxPage = {
  gifts: InboxGift[];
  nextToBlock: bigint | null;
  blockTimestamp: bigint;
  blockNumber: bigint;
  maxBatch: number;
};

const claimPhaseLabels: Record<ClaimPhase, string> = {
  awaiting_claim: "Confirm the claim",
  confirming_claim: "Claim is settling",
  success: "Gift claimed",
};

const stateLabels: Record<GiftRowState, string> = {
  ready: "ready",
  locked: "locked",
  claimed: "claimed",
  confirming: "confirming",
  syncing: "syncing",
  "needs-attention": "needs attention",
  retired: "ready",
  unreadable: "unreadable",
};

const stateBadges: Record<GiftRowState, string> = {
  ready: "gift-state gift-state-ready",
  locked: "gift-state gift-state-locked",
  claimed: "gift-state gift-state-claimed",
  confirming: "gift-state bg-sky/12 text-sky-deep",
  syncing: "gift-state bg-sky/12 text-sky-deep",
  "needs-attention": "gift-state bg-poppy/18 text-[#9f2e18]",
  retired: "gift-state bg-sun/30 text-ink",
  unreadable: "gift-state bg-ink/10 text-ink-soft",
};

const exclusionCopy: Record<ExclusionReason, string> = {
  locked: "Locked until the opening day, so it cannot be claimed yet.",
  claimed: "Already claimed to this wallet.",
  confirming: "A claim submitted from this browser is still confirming.",
  unreadable: "The vault read for this gift failed. Refresh before claiming it.",
  conflict: "Saved history and the vault disagree about this gift. Refresh before claiming it.",
  cap_reached: "The batch is full. Clear another gift to add this one.",
};

function readPendingClaim(key: string | null) {
  if (!key || typeof window === "undefined") return null;
  try {
    return decodePendingClaim(window.localStorage.getItem(key) ?? "");
  } catch {
    return null;
  }
}

function writePendingClaim(key: string | null, claim: PendingClaimSubmission | null) {
  if (!key || typeof window === "undefined") return;
  try {
    if (claim) window.localStorage.setItem(key, encodePendingClaim(claim));
    else window.localStorage.removeItem(key);
  } catch {}
}

function useInbox(deployment: AppDeployment, recipient: Address | undefined) {
  const client = usePublicClient({ chainId: deployment.chainId });
  return useInfiniteQuery({
    queryKey: ["gift-inbox", deployment.chainId, deployment.vaultAddress, recipient],
    enabled:
      client !== undefined &&
      recipient !== undefined &&
      deployment.vaultAddress !== null &&
      deployment.deploymentBlock !== null,
    initialPageParam: null as bigint | null,
    queryFn: async ({ pageParam }): Promise<InboxPage> => {
      const vaultAddress = deployment.vaultAddress;
      if (!client || !recipient || !vaultAddress || deployment.deploymentBlock === null) {
        return {
          gifts: [],
          nextToBlock: null,
          blockTimestamp: 0n,
          blockNumber: 0n,
          maxBatch: DEFAULT_MAX_BATCH,
        };
      }
      const block = await client.getBlock({ blockTag: "latest" });
      if (block.number === null) throw new Error("Latest block has no number");
      const deploymentBlock = BigInt(deployment.deploymentBlock);
      const toBlock = pageParam ?? block.number;
      const span = BLOCK_PAGE_SPAN - 1n;
      const fromBlock = toBlock - deploymentBlock > span ? toBlock - span : deploymentBlock;

      const page = await readLogRange(
        (from, to) =>
          client.getContractEvents({
            address: vaultAddress,
            abi: sowmorrowVaultAbi,
            eventName: "GiftCreated",
            args: { recipient },
            fromBlock: from,
            toBlock: to,
            strict: true,
          }),
        fromBlock,
        toBlock,
        MAX_LOGS_PER_PAGE,
      );
      const olderCursor = fromBlock > deploymentBlock ? fromBlock - 1n : null;
      const nextToBlock = page.nextToBlock ?? olderCursor;
      const logs = page.logs;
      if (logs.length === 0) {
        return {
          gifts: [],
          nextToBlock,
          blockTimestamp: block.timestamp,
          blockNumber: block.number,
          maxBatch: DEFAULT_MAX_BATCH,
        };
      }

      const giftResults = (await chunkedCalls(
        (contracts) => client.multicall({ allowFailure: true, contracts }),
        logs.map((log) => ({
          address: vaultAddress,
          abi: sowmorrowVaultAbi,
          functionName: "getGift" as const,
          args: [log.args.giftId] as const,
        })),
        MULTICALL_CHUNK,
      )) as readonly ReadResult<GiftStruct>[];

      if (
        giftResults.some(
          (result) =>
            result.status === "success" && result.result.recipient.toLowerCase() !== recipient.toLowerCase(),
        )
      ) {
        throw new Error("The vault returned a gift addressed to a different recipient");
      }

      const uniqueStocks = [...new Set(logs.map((log) => log.args.stock.toLowerCase()))].map(
        (addressLower) => logs.find((log) => log.args.stock.toLowerCase() === addressLower)!.args.stock,
      );
      const decimalResults = (await chunkedCalls(
        (contracts) => client.multicall({ allowFailure: true, contracts }),
        uniqueStocks.map((stock) => ({
          address: stock,
          abi: ib20Abi,
          functionName: "decimals" as const,
        })),
        MULTICALL_CHUNK,
      )) as readonly ReadResult<number>[];
      const supportResults = (await chunkedCalls(
        (contracts) => client.multicall({ allowFailure: true, contracts }),
        uniqueStocks.map((stock) => ({
          address: vaultAddress,
          abi: sowmorrowVaultAbi,
          functionName: "supportedStock" as const,
          args: [stock] as const,
        })),
        MULTICALL_CHUNK,
      )) as readonly ReadResult<boolean>[];
      const scaledResults = (await chunkedCalls(
        (contracts) => client.multicall({ allowFailure: true, contracts }),
        logs.map((log) => ({
          address: log.args.stock,
          abi: ib20AssetAbi,
          functionName: "toScaledBalance" as const,
          args: [log.args.amountRaw] as const,
        })),
        MULTICALL_CHUNK,
      )) as readonly ReadResult<bigint>[];
      const batchResults = (await client.multicall({
        allowFailure: true,
        contracts: [{ address: vaultAddress, abi: sowmorrowVaultAbi, functionName: "MAX_BATCH" }],
      })) as readonly ReadResult<bigint>[];

      const decimalsByStock = new Map(
        uniqueStocks.map(
          (stock, index) =>
            [
              stock.toLowerCase(),
              decimalResults[index]?.status === "success" ? decimalResults[index].result : null,
            ] as const,
        ),
      );
      const supportByStock = new Map(
        uniqueStocks.map(
          (stock, index) =>
            [
              stock.toLowerCase(),
              supportResults[index]?.status === "success" ? supportResults[index].result : null,
            ] as const,
        ),
      );

      const maxBatchResult = batchResults[0];
      const maxBatch =
        maxBatchResult?.status === "success" && maxBatchResult.result > 0n
          ? Number(maxBatchResult.result)
          : DEFAULT_MAX_BATCH;

      const gifts = logs.map((log, index) => {
        const chainGift = giftResults[index];
        const scaled = scaledResults[index];
        const stockLower = log.args.stock.toLowerCase();
        const knownStock = stocks.find(
          (stock) => deployment.stockAddresses[stock.symbol]?.toLowerCase() === stockLower,
        );
        return {
          id: log.args.giftId,
          sender: log.args.sender,
          stock: log.args.stock,
          symbol: knownStock?.symbol ?? "B20",
          amountRaw: log.args.amountRaw,
          unlockAt: log.args.unlockAt,
          decimals: decimalsByStock.get(stockLower) ?? null,
          amountScaled: scaled?.status === "success" ? scaled.result : null,
          chainStatus:
            chainGift?.status === "success"
              ? chainGift.result.status === 2
                ? ("claimed" as const)
                : ("active" as const)
              : null,
          chainUnlockAt: chainGift?.status === "success" ? chainGift.result.unlockAt : null,
          supported: supportByStock.get(stockLower) ?? null,
        } satisfies InboxGift;
      });

      return { gifts, nextToBlock, blockTimestamp: block.timestamp, blockNumber: block.number, maxBatch };
    },
    getNextPageParam: (lastPage) => lastPage.nextToBlock,
  });
}

function formatAmount(row: GiftRow) {
  if (row.amountScaled === null || row.decimals === null) return `${row.amountRaw} raw units`;
  return `${formatUnits(row.amountScaled, row.decimals)} ${row.symbol}`;
}

function GiftRowItem({
  row,
  selected,
  capReached,
  disabled,
  onToggle,
}: {
  row: GiftRow;
  selected: boolean;
  capReached: boolean;
  disabled: boolean;
  onToggle: (id: string, next: boolean) => void;
}) {
  const key = row.id.toString();
  const reason: ExclusionReason | null = row.selectable
    ? capReached && !selected
      ? "cap_reached"
      : null
    : row.reason;
  const descriptionId = reason === null && row.mirror !== "behind" ? undefined : `gift-${key}-reason`;
  return (
    <motion.li variants={entranceItem} className="flex items-start gap-3 py-3">
      <input
        type="checkbox"
        id={`gift-${key}`}
        checked={selected}
        disabled={disabled || reason !== null}
        aria-describedby={descriptionId}
        onChange={(event) => onToggle(key, event.target.checked)}
        className="mt-1 size-5 shrink-0 accent-[#2a6b34] focus-visible:outline-3 focus-visible:outline-meadow/50 disabled:opacity-40"
      />
      <StockDot symbol={row.symbol} />
      <div className="min-w-0 flex-1">
        <label htmlFor={`gift-${key}`} className="block truncate text-[14px] font-extrabold text-ink">
          {formatAmount(row)}
        </label>
        <p className="truncate text-[11px] text-ink-soft">
          from {shortAddress(row.sender)} ·{" "}
          {row.state === "locked"
            ? `opens ${new Date(Number(row.chainUnlockAt ?? row.unlockAt) * 1_000).toLocaleDateString()}`
            : row.state === "claimed"
              ? "claimed"
              : row.state === "retired"
                ? "ready now"
                : row.state === "ready"
                  ? "ready now"
                  : stateLabels[row.state]}
        </p>
        {descriptionId && (
          <p id={descriptionId} className="mt-0.5 text-[10px] leading-snug text-ink-soft">
            {reason !== null && exclusionCopy[reason]}
            {reason !== null && row.mirror === "behind" && " "}
            {row.mirror === "behind" &&
              `Saved history still shows this gift as ${row.mirrorStatus}; the vault is authoritative.`}
          </p>
        )}
        {row.state === "retired" && (
          <p className="mt-0.5 text-[10px] font-bold leading-snug text-[#8b4b22]">
            This stock is no longer open for new gifts. This gift is still yours to claim.
          </p>
        )}
        {row.state === "needs-attention" && (
          <p className="mt-0.5 text-[10px] leading-snug text-ink-soft">
            Vault: {row.chainStatus} · saved history: {row.mirrorStatus ?? "unknown"}
          </p>
        )}
      </div>
      <span className={stateBadges[row.state]}>{stateLabels[row.state]}</span>
    </motion.li>
  );
}

export function ClaimFace({ deployment, entrance, onClaim }: Props) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const reduceMotion = useReducedMotion();
  const entranceState = useEntranceSettled(reduceMotion);
  const client = usePublicClient({ chainId: deployment.chainId });
  const queryClient = useQueryClient();
  const inbox = useInbox(deployment, connection.address);
  const [phase, setPhase] = useState<ClaimPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastHash, setLastHash] = useState<Hash | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [showSmall, setShowSmall] = useState(false);
  const [retryGroups, setRetryGroups] = useState<{ key: string; symbol: string; ids: bigint[] }[]>([]);
  const [pendingClaim, setPendingClaim] = useState<PendingClaimSubmission | null>(null);
  const busy = phase !== null && phase !== "success";

  const storageKey =
    deployment.vaultAddress && connection.address
      ? pendingClaimStorageKey(deployment.chainId, deployment.vaultAddress, connection.address)
      : null;

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      const persisted = readPendingClaim(storageKey);
      if (current && persisted) setPendingClaim(persisted);
    });
    return () => {
      current = false;
    };
  }, [storageKey]);

  const mirrorGifts = useMirrorQuery(
    mirrorApi.giftsForRecipient,
    connection.address
      ? {
          chainId: deployment.chainId,
          recipientLower: connection.address.toLowerCase(),
          paginationOpts: { numItems: 100, cursor: null },
        }
      : null,
  );
  const mirrorFreshness = useMirrorQuery(mirrorApi.freshness, { chainId: deployment.chainId });

  const mirrorById = useMemo(() => {
    const entries = new Map<string, MirrorGift>();
    const vaultLower = deployment.vaultAddress?.toLowerCase();
    for (const row of mirrorGifts.data?.page ?? []) {
      if (vaultLower !== undefined && row.vaultAddressLower !== vaultLower) continue;
      entries.set(row.giftIdDecimal, {
        giftId: BigInt(row.giftIdDecimal),
        status: row.state,
        amountRaw: BigInt(row.amountRawDecimal),
        recipientLower: row.recipientLower,
      });
    }
    return entries;
  }, [mirrorGifts.data, deployment.vaultAddress]);

  const pages = useMemo(() => inbox.data?.pages ?? [], [inbox.data]);
  const maxBatch = pages[0]?.maxBatch ?? DEFAULT_MAX_BATCH;
  const blockTimestamp = pages[0]?.blockTimestamp ?? 0n;
  const confirmingIds = useMemo(
    () => new Set((pendingClaim?.giftIds ?? []).map((giftId) => giftId.toString())),
    [pendingClaim],
  );

  const rows = useMemo(() => {
    const unique = new Map<string, InboxGift>();
    for (const page of pages) for (const gift of page.gifts) unique.set(gift.id.toString(), gift);
    return [...unique.values()]
      .map((gift) =>
        classifyGift(gift, {
          blockTimestamp,
          confirmingIds,
          mirrorEnabled: mirrorGifts.connected && mirrorGifts.error === null,
          mirrorById,
        }),
      )
      .sort(compareRows);
  }, [pages, blockTimestamp, confirmingIds, mirrorGifts.connected, mirrorGifts.error, mirrorById]);

  const mirrorSenders = useMemo(
    () => (mirrorGifts.data?.page ?? []).map((row) => row.senderLower),
    [mirrorGifts.data],
  );

  const partition = useMemo(
    () => partitionSmallGifts(rows, smallAmountThresholds(rows), knownCounterparties(rows, mirrorSenders)),
    [rows, mirrorSenders],
  );

  const primaryGroups = useMemo(() => groupByStock(partition.primary), [partition.primary]);
  const smallGroups = useMemo(() => groupByStock(partition.small), [partition.small]);
  const selectedRows = useMemo(() => limitSelection(selected, rows, maxBatch), [selected, rows, maxBatch]);
  const capReached = selectedRows.length >= maxBatch;

  const toggle = (id: string, next: boolean) => {
    setSelected((current) => {
      const updated = new Set(current);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  };

  const selectGroup = (ids: readonly bigint[]) => {
    setSelected((current) => {
      const updated = new Set(current);
      for (const id of ids) {
        if (updated.size >= maxBatch) break;
        updated.add(id.toString());
      }
      return updated;
    });
  };

  const claimSelected = async (rowsToClaim: readonly GiftRow[]) => {
    const vaultAddress = deployment.vaultAddress;
    const account = connection.address;
    if (!client || !vaultAddress || !account || rowsToClaim.length === 0) return;
    setError(null);
    setRetryGroups([]);
    setLastHash(null);
    const giftIds = rowsToClaim.map((row) => row.id);
    const remember = (hash: Hash) => {
      const submission: PendingClaimSubmission = {
        version: 1,
        chainId: deployment.chainId,
        hash,
        vault: vaultAddress,
        account,
        giftIds: [...giftIds],
        submittedAt: Math.floor(Date.now() / 1_000),
      };
      setPendingClaim(submission);
      writePendingClaim(storageKey, submission);
    };

    try {
      const hash = await executeClaim(
        {
          claim: async (giftId) => {
            await client.simulateContract({
              account,
              address: vaultAddress,
              abi: sowmorrowVaultAbi,
              functionName: "claim",
              args: [giftId],
            });
            const submitted = await write.mutateAsync({
              address: vaultAddress,
              abi: sowmorrowVaultAbi,
              functionName: "claim",
              args: [giftId],
              chainId: deployment.chainId,
            });
            remember(submitted);
            return submitted;
          },
          claimMany: async (ids) => {
            await client.simulateContract({
              account,
              address: vaultAddress,
              abi: sowmorrowVaultAbi,
              functionName: "claimMany",
              args: [[...ids]],
            });
            const submitted = await write.mutateAsync({
              address: vaultAddress,
              abi: sowmorrowVaultAbi,
              functionName: "claimMany",
              args: [[...ids]],
              chainId: deployment.chainId,
            });
            remember(submitted);
            return submitted;
          },
          waitForClaimReceipt: async (transactionHash, expected) => {
            const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
            proveGiftClaimed(receipt, vaultAddress, expected);
          },
        },
        rowsToClaim.map((row) => ({
          giftId: row.id,
          recipient: account,
          stock: row.stock,
          amountRaw: row.amountRaw,
        })),
        setPhase,
      );
      setLastHash(hash);
      setPendingClaim(null);
      writePendingClaim(storageKey, null);
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ["gift-inbox"] });
      onClaim();
    } catch (caught) {
      setPhase(null);
      const mapped = mapFlowError(caught);
      const revertName = revertedErrorName(caught);
      setError(
        revertName === null ? friendlyError(caught) : `${mapped.message} The vault reported ${revertName}.`,
      );
      const attempted = groupByStock(rowsToClaim);
      setRetryGroups(
        attempted.length > 1
          ? attempted.map((group) => ({
              key: group.key,
              symbol: group.symbol,
              ids: group.rows.map((row) => row.id),
            }))
          : [],
      );
    }
  };

  const recoverPendingClaim = async () => {
    if (!client || !pendingClaim) return;
    setPhase("confirming_claim");
    setError(null);
    try {
      const receipt = await readReceiptWithFallback(
        [client, secondaryPublicClient(deployment.chainId)],
        pendingClaim.hash,
      );
      const expected = pendingClaim.giftIds.flatMap((giftId) => {
        const row = rows.find((candidate) => candidate.id === giftId);
        return row && connection.address
          ? [{ giftId, recipient: connection.address, stock: row.stock, amountRaw: row.amountRaw }]
          : [];
      });
      if (expected.length === pendingClaim.giftIds.length) {
        proveGiftClaimed(receipt, pendingClaim.vault, expected);
      } else if (receipt.status !== "success") {
        throw new Error("The submitted claim reverted");
      }
      setPendingClaim(null);
      writePendingClaim(storageKey, null);
      setPhase("success");
      setLastHash(pendingClaim.hash);
      await queryClient.invalidateQueries({ queryKey: ["gift-inbox"] });
      onClaim();
    } catch (caught) {
      setPhase(null);
      setError(friendlyError(caught));
    }
  };

  const act = () => {
    if (!connection.isConnected) {
      const connector = connectors[0];
      if (connector) connect.mutate({ connector });
      else setError("No compatible browser wallet was found.");
      return;
    }
    if (connection.chainId !== deployment.chainId) {
      switchChain.mutate({ chainId: deployment.chainId });
      return;
    }
    void claimSelected(selectedRows);
  };

  const explorer = lastHash ? transactionLink(deployment, lastHash) : null;
  const wrongChain = connection.isConnected && connection.chainId !== deployment.chainId;
  const inboxError = inbox.error;
  const readyCount = rows.filter((row) => row.selectable).length;

  const renderGroups = (groups: ReturnType<typeof groupByStock>) =>
    groups.map((group) => (
      <section key={group.key} aria-label={`${group.symbol} gifts`} className="mt-1">
        <div className="flex items-center justify-between gap-3 border-b border-ink/8 pb-1">
          <p className="text-[11px] font-black uppercase tracking-[0.08em] text-ink-soft">
            {group.symbol} · {group.rows.length}
          </p>
          <button
            type="button"
            onClick={() => selectGroup(group.readyIds)}
            disabled={busy || group.readyIds.length === 0 || capReached}
            className="text-[11px] font-extrabold text-sky-deep underline underline-offset-2 disabled:no-underline disabled:opacity-45"
          >
            Select all ready ({group.readyIds.length})
          </button>
        </div>
        <ul className="divide-y divide-ink/8">
          {group.rows.map((row) => (
            <GiftRowItem
              key={row.id.toString()}
              row={row}
              selected={selected.has(row.id.toString())}
              capReached={capReached}
              disabled={busy}
              onToggle={toggle}
            />
          ))}
        </ul>
      </section>
    ));

  return (
    <motion.section
      id="claim-panel"
      role="tabpanel"
      aria-label="Claim"
      variants={claimEntrance(entrance)}
      initial={reduceMotion ? false : "hidden"}
      animate="show"
      onAnimationComplete={entranceState.settle}
      className="flex min-h-[400px] min-w-0 flex-1 flex-col gap-4 px-4 pb-4 pt-3 text-left sm:min-h-0 sm:px-5 sm:pb-5 sm:pt-3"
    >
      <div
        data-testid="claim-scroll-region"
        className={`scroll-region flex min-h-0 flex-1 flex-col gap-4 sm:overscroll-contain sm:pr-1 ${entranceState.scrollable ? "sm:overflow-y-auto" : "sm:overflow-hidden"}`}
      >
        <motion.div variants={entranceItem} className="flex items-end justify-between gap-4">
          <div>
            <p className="display text-[25px] leading-tight text-ink">Your planted gifts</p>
            <p className="mt-1 text-[12px] text-ink-soft">
              Claiming never closes, even if new planting is paused.
            </p>
          </div>
          {inbox.isFetching && <Spinner />}
        </motion.div>

        {(!mirrorConfigured || !mirrorGifts.connected || mirrorGifts.error !== null) && (
          <motion.div variants={entranceItem}>
            <MirrorNotice />
          </motion.div>
        )}
        {mirrorGifts.connected &&
          mirrorGifts.error === null &&
          (mirrorFreshness.data?.lagBlocks ?? 0) > 0 && (
            <motion.div variants={entranceItem}>
              <MirrorNotice lagBlocks={mirrorFreshness.data?.lagBlocks ?? null} />
            </motion.div>
          )}

        {pendingClaim && (
          <motion.section
            variants={entranceItem}
            aria-label="Submitted claim recovery"
            className="rounded-2xl border border-sun-deep/30 bg-sun/14 p-3 text-[11px] leading-relaxed text-ink-soft"
          >
            <p className="font-extrabold text-ink">A claim transaction is already submitted.</p>
            <p>Wait for its receipt before submitting the same gifts again.</p>
            <p className="mt-1 break-all font-mono text-[9px] text-ink">{pendingClaim.hash}</p>
            <button
              type="button"
              onClick={() => void recoverPendingClaim()}
              disabled={busy}
              className="mt-2 font-extrabold text-sky-deep underline underline-offset-2"
            >
              Check claim
            </button>
          </motion.section>
        )}

        <motion.div variants={entranceItem} className="min-h-[210px] flex-1">
          {!deployment.vaultAddress || deployment.deploymentBlock === null ? (
            <div className="empty-state">
              <span className="text-3xl" aria-hidden="true">
                ⌛
              </span>
              <p className="font-extrabold text-ink">The vault is not deployed yet.</p>
              <p>Claim history will appear here as soon as a reviewed deployment manifest is active.</p>
            </div>
          ) : !connection.isConnected ? (
            <div className="empty-state">
              <span className="text-3xl" aria-hidden="true">
                🌱
              </span>
              <p className="font-extrabold text-ink">Connect to see what is growing.</p>
              <p>Gifts are looked up by the connected recipient address.</p>
            </div>
          ) : wrongChain ? (
            <div className="empty-state">
              <span className="text-3xl" aria-hidden="true">
                🧭
              </span>
              <p className="font-extrabold text-ink">Your wallet is on another network.</p>
              <p>Sowmorrow does not read gifts for this account on a different chain.</p>
              <button
                type="button"
                onClick={() => switchChain.mutate({ chainId: deployment.chainId })}
                className="text-[12px] font-extrabold text-sky-deep underline"
              >
                Switch to {deployment.networkName}
              </button>
            </div>
          ) : inbox.isPending ? (
            <div className="empty-state" role="status">
              <Spinner />
              <p>Reading the vault&hellip;</p>
            </div>
          ) : inbox.isError ? (
            <div className="empty-state" role="alert">
              <p className="font-extrabold text-ink">The garden could not be read.</p>
              <p>
                {inboxError instanceof LogRangeError
                  ? "This RPC could not return a bounded range of gift events."
                  : friendlyError(inboxError)}
              </p>
              <button
                type="button"
                onClick={() => void inbox.refetch()}
                className="text-[12px] font-extrabold text-sky-deep underline"
              >
                Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="empty-state">
              <p className="font-extrabold text-ink">No gifts in the blocks checked so far.</p>
              <p>
                {inbox.hasNextPage
                  ? "Load an older bounded block range to keep looking."
                  : "When someone plants one for you, it will appear here."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-extrabold text-ink-soft" role="status">
                {selectedRows.length} of {maxBatch} selected · {readyCount} ready
              </p>
              {partition.primary.length === 0 ? (
                <div className="empty-state">
                  <p className="font-extrabold text-ink">Nothing here yet but small gifts.</p>
                  <p>Every gift found so far is dust-sized or from a sender you have not claimed from.</p>
                </div>
              ) : (
                renderGroups(primaryGroups)
              )}

              {partition.small.length > 0 && (
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => setShowSmall((current) => !current)}
                    aria-expanded={showSmall}
                    aria-controls="small-gifts"
                    className="w-full rounded-xl border border-ink/10 px-3 py-2 text-[11px] font-extrabold text-sky-deep"
                  >
                    {showSmall ? "Hide" : "Show"} {partition.small.length} small gift
                    {partition.small.length === 1 ? "" : "s"}
                  </button>
                  <div id="small-gifts" hidden={!showSmall}>
                    <p className="mt-2 text-[10px] leading-snug text-ink-soft">
                      Dust-sized amounts and senders you have not claimed from before. They are never selected
                      for you.
                    </p>
                    {renderGroups(smallGroups)}
                  </div>
                </div>
              )}
            </div>
          )}
          {inbox.hasNextPage && !inbox.isPending && !inbox.isError && (
            <button
              type="button"
              onClick={() => void inbox.fetchNextPage()}
              disabled={inbox.isFetchingNextPage}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-ink/10 px-3 py-2 text-[11px] font-extrabold text-sky-deep disabled:opacity-60"
            >
              {inbox.isFetchingNextPage && <Spinner />}
              {inbox.isFetchingNextPage ? "Checking older blocks" : "Load older gifts"}
            </button>
          )}
        </motion.div>

        {phase && phase !== "success" && <ProgressNotice label={claimPhaseLabels[phase]} />}
        {phase === "success" && (
          <p
            role="status"
            className="rounded-xl bg-meadow/12 px-3 py-2 text-[12px] font-extrabold text-meadow-deep"
          >
            Claimed safely to this wallet.{" "}
            {explorer && (
              <a href={explorer} target="_blank" rel="noreferrer" className="ml-1 underline">
                View transaction
              </a>
            )}
          </p>
        )}
        {error && (
          <div role="alert" className="rounded-xl bg-poppy/10 px-3 py-2 text-[12px] font-bold text-[#9f2e18]">
            <p>{error}</p>
            {retryGroups.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-3">
                {retryGroups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const ids = new Set(group.ids.map((id) => id.toString()));
                      setSelected(ids);
                      void claimSelected(limitSelection(ids, rows, maxBatch));
                    }}
                    className="font-extrabold text-sky-deep underline underline-offset-2"
                  >
                    Retry {group.symbol} only ({group.ids.length})
                  </button>
                ))}
              </p>
            )}
          </div>
        )}
      </div>

      <motion.div variants={entranceItem} className="flex shrink-0 flex-col gap-2">
        <ConnectorPicker enabled={deployment.writesEnabled} />
        <button
          type="button"
          onClick={act}
          disabled={
            !deployment.writesEnabled ||
            busy ||
            pendingClaim !== null ||
            (connection.isConnected && connection.chainId === deployment.chainId && selectedRows.length === 0)
          }
          className="primary-button flex items-center justify-center gap-2"
        >
          {busy && <Spinner />}
          {!deployment.writesEnabled
            ? "Vault deployment pending"
            : !connection.isConnected
              ? "Connect wallet"
              : wrongChain
                ? `Switch to ${deployment.networkName}`
                : busy && phase
                  ? claimPhaseLabels[phase]
                  : pendingClaim
                    ? "Confirmation required"
                    : selectedRows.length > 0
                      ? `Claim ${selectedRows.length} selected gift${selectedRows.length === 1 ? "" : "s"}`
                      : readyCount > 0
                        ? "Select gifts to claim"
                        : "Nothing ready yet"}
        </button>
      </motion.div>
    </motion.section>
  );
}
