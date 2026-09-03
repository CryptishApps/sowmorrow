import type { Address } from "viem";

export const BLOCK_PAGE_SPAN = 2_000n;
export const MAX_LOGS_PER_PAGE = 200;
export const MULTICALL_CHUNK = 100;
export const DEFAULT_MAX_BATCH = 20;
export const SMALL_AMOUNT_DIVISOR = 1_000n;

export type LogRangeErrorCode = "range_unreadable" | "too_many_logs";

export class LogRangeError extends Error {
  constructor(
    public readonly code: LogRangeErrorCode,
    public readonly fromBlock: bigint,
    public readonly toBlock: bigint,
    options?: { cause?: unknown },
  ) {
    super(
      code === "too_many_logs"
        ? "A single block holds more gift events than this page can read."
        : "The configured RPC could not return gift events for this block range.",
      options,
    );
    this.name = "LogRangeError";
  }
}

export type LogRangeReader<log> = (fromBlock: bigint, toBlock: bigint) => Promise<readonly log[]>;

export async function readLogRange<log>(
  reader: LogRangeReader<log>,
  fromBlock: bigint,
  toBlock: bigint,
  cap: number = MAX_LOGS_PER_PAGE,
): Promise<{ logs: log[]; nextToBlock: bigint | null }> {
  if (toBlock < fromBlock) return { logs: [], nextToBlock: null };

  let logs: readonly log[] | null = null;
  try {
    logs = await reader(fromBlock, toBlock);
  } catch (cause) {
    if (fromBlock === toBlock) throw new LogRangeError("range_unreadable", fromBlock, toBlock, { cause });
  }

  if (logs !== null && logs.length <= cap) return { logs: [...logs], nextToBlock: null };
  if (fromBlock === toBlock) throw new LogRangeError("too_many_logs", fromBlock, toBlock);

  const middle = fromBlock + (toBlock - fromBlock) / 2n;
  const upper = await readLogRange(reader, middle + 1n, toBlock, cap);
  if (upper.nextToBlock !== null) return upper;
  if (upper.logs.length >= cap) return { logs: upper.logs, nextToBlock: middle };

  const lower = await readLogRange(reader, fromBlock, middle, cap - upper.logs.length);
  return { logs: [...upper.logs, ...lower.logs], nextToBlock: lower.nextToBlock };
}

export async function chunkedCalls<call, result>(
  run: (calls: readonly call[]) => Promise<readonly result[]>,
  calls: readonly call[],
  size: number = MULTICALL_CHUNK,
): Promise<result[]> {
  const results: result[] = [];
  for (let start = 0; start < calls.length; start += size) {
    const chunk = await run(calls.slice(start, start + size));
    results.push(...chunk);
  }
  return results;
}

export type MirrorGift = {
  giftId: bigint;
  status: "active" | "claimed";
  amountRaw: bigint;
  recipientLower: string;
};

export type InboxGift = {
  id: bigint;
  sender: Address;
  stock: Address;
  symbol: string;
  amountRaw: bigint;
  unlockAt: bigint;
  decimals: number | null;
  amountScaled: bigint | null;
  chainStatus: "active" | "claimed" | null;
  chainUnlockAt: bigint | null;
  supported: boolean | null;
};

export type GiftRowState =
  "ready" | "locked" | "claimed" | "confirming" | "syncing" | "needs-attention" | "retired" | "unreadable";

export type MirrorAgreement = "off" | "absent" | "synced" | "behind" | "conflict";

export type ExclusionReason = "locked" | "claimed" | "confirming" | "unreadable" | "conflict" | "cap_reached";

export type GiftRow = InboxGift & {
  state: GiftRowState;
  mirror: MirrorAgreement;
  mirrorStatus: "active" | "claimed" | null;
  selectable: boolean;
  reason: ExclusionReason | null;
};

export type ClassifyContext = {
  blockTimestamp: bigint;
  confirmingIds: ReadonlySet<string>;
  mirrorEnabled: boolean;
  mirrorById: ReadonlyMap<string, MirrorGift>;
};

export function classifyGift(gift: InboxGift, context: ClassifyContext): GiftRow {
  const key = gift.id.toString();
  const mirrorGift = context.mirrorById.get(key);
  const mirrorStatus = mirrorGift?.status ?? null;
  const unlockAt = gift.chainUnlockAt ?? gift.unlockAt;

  let mirror: MirrorAgreement = "off";
  if (context.mirrorEnabled) {
    if (mirrorGift === undefined) mirror = "absent";
    else if (gift.chainStatus === null) mirror = "synced";
    else if (mirrorGift.amountRaw !== gift.amountRaw) mirror = "conflict";
    else if (mirrorGift.status === gift.chainStatus) mirror = "synced";
    else if (gift.chainStatus === "claimed") mirror = "behind";
    else mirror = "conflict";
  }

  const row = (state: GiftRowState, selectable: boolean, reason: ExclusionReason | null): GiftRow => ({
    ...gift,
    state,
    mirror,
    mirrorStatus,
    selectable,
    reason,
  });

  if (gift.chainStatus === null) return row("unreadable", false, "unreadable");
  if (context.confirmingIds.has(key)) return row("confirming", false, "confirming");
  if (mirror === "conflict") return row("needs-attention", false, "conflict");
  if (gift.chainStatus === "claimed") {
    return mirror === "behind" ? row("syncing", false, "claimed") : row("claimed", false, "claimed");
  }
  if (unlockAt > context.blockTimestamp) return row("locked", false, "locked");
  return gift.supported === false ? row("retired", true, null) : row("ready", true, null);
}

export function compareRows(left: GiftRow, right: GiftRow): number {
  const leftAmount = left.amountScaled;
  const rightAmount = right.amountScaled;
  if (leftAmount === null || rightAmount === null) {
    if (leftAmount !== rightAmount) return leftAmount === null ? 1 : -1;
  } else if (leftAmount !== rightAmount) {
    return leftAmount > rightAmount ? -1 : 1;
  }
  return left.id > right.id ? -1 : left.id < right.id ? 1 : 0;
}

export function smallAmountThresholds(rows: readonly GiftRow[]): Map<string, bigint> {
  const largest = new Map<string, bigint>();
  for (const row of rows) {
    if (row.amountScaled === null) continue;
    const key = row.stock.toLowerCase();
    const current = largest.get(key);
    if (current === undefined || row.amountScaled > current) largest.set(key, row.amountScaled);
  }
  return new Map([...largest].map(([key, amount]) => [key, amount / SMALL_AMOUNT_DIVISOR] as const));
}

export function knownCounterparties(
  rows: readonly GiftRow[],
  mirrorSenders: Iterable<string> = [],
): Set<string> {
  const counts = new Map<string, number>();
  const known = new Set<string>(mirrorSenders);
  for (const row of rows) {
    const sender = row.sender.toLowerCase();
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
    if (row.chainStatus === "claimed") known.add(sender);
  }
  for (const [sender, count] of counts) if (count > 1) known.add(sender);
  return known;
}

export function partitionSmallGifts(
  rows: readonly GiftRow[],
  thresholds: ReadonlyMap<string, bigint>,
  counterparties: ReadonlySet<string>,
): { primary: GiftRow[]; small: GiftRow[] } {
  const primary: GiftRow[] = [];
  const small: GiftRow[] = [];
  for (const row of rows) {
    const threshold = thresholds.get(row.stock.toLowerCase());
    const belowThreshold =
      row.amountScaled !== null && threshold !== undefined && threshold > 0n
        ? row.amountScaled < threshold
        : false;
    const unfamiliarSender = !counterparties.has(row.sender.toLowerCase());
    if (belowThreshold || unfamiliarSender) small.push(row);
    else primary.push(row);
  }
  return { primary, small };
}

export type StockGroup = {
  key: string;
  stock: Address;
  symbol: string;
  rows: GiftRow[];
  readyIds: bigint[];
};

export function groupByStock(rows: readonly GiftRow[]): StockGroup[] {
  const groups = new Map<string, StockGroup>();
  for (const row of rows) {
    const key = row.stock.toLowerCase();
    const group = groups.get(key) ?? {
      key,
      stock: row.stock,
      symbol: row.symbol,
      rows: [],
      readyIds: [],
    };
    group.rows.push(row);
    if (row.selectable) group.readyIds.push(row.id);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, rows: [...group.rows].sort(compareRows) }));
}

export function limitSelection(
  selected: ReadonlySet<string>,
  rows: readonly GiftRow[],
  maxBatch: number = DEFAULT_MAX_BATCH,
): GiftRow[] {
  return rows.filter((row) => row.selectable && selected.has(row.id.toString())).slice(0, maxBatch);
}
