import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { encodeAbiParameters, encodeEventTopics, getAddress } from "viem";
import type { Address, Hash, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sowmorrowVaultAbi } from "../lib/contracts/generated";
import { deploymentRegistry } from "../lib/contracts/manifests";
import schema from "./schema";
import type { ChainReceipt, ChainRpc, FactoryCreationLog, TokenIdentity, VaultEventLog } from "./rpc";

const { rpcRegistry } = vi.hoisted(() => ({ rpcRegistry: new Map<string, unknown>() }));

vi.mock("./rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rpc")>();
  return {
    ...actual,
    createChainRpc: (_chainId: number, url: string) => {
      const rpc = rpcRegistry.get(url);
      if (!rpc) throw new Error(`no fake rpc registered for ${url}`);
      return rpc as ChainRpc;
    },
  };
});

const modules = import.meta.glob("./**/*.ts");

const reconcileConfiguredVault = makeFunctionReference<"action">("reconciliation:reconcileConfiguredVault");
const reconcileDelivery = makeFunctionReference<"action">("reconciliation:reconcileDelivery");
const retryDueDeliveries = makeFunctionReference<"action">("reconciliation:retryDueDeliveries");
const repairHaltedCursor = makeFunctionReference<"action">("reconciliation:repairHaltedCursor");
const scanFactoryCandidates = makeFunctionReference<"action">("discovery:scanFactoryCandidates");
const checkVaultSolvencyAndLag = makeFunctionReference<"action">("monitor:checkVaultSolvencyAndLag");
const applyCanonicalVaultLog = makeFunctionReference<"mutation">("events:applyCanonicalVaultLog");
const recordVerifiedDelivery = makeFunctionReference<"mutation">("webhooks:recordVerifiedDelivery");
const haltCursor = makeFunctionReference<"mutation">("indexer:haltCursor");
const advanceCursor = makeFunctionReference<"mutation">("indexer:advanceCursor");
const resumeHaltedCursor = makeFunctionReference<"mutation">("indexer:resumeHaltedCursor");
const rewindCursor = makeFunctionReference<"mutation">("indexer:rewindCursor");
const initializeCursor = makeFunctionReference<"mutation">("indexer:initializeCursor");
const recordActiveDeployment = makeFunctionReference<"mutation">("indexer:recordActiveDeployment");
const proposeReviewedStock = makeFunctionReference<"mutation">("catalog:proposeReviewedStock");
const approveReviewedStock = makeFunctionReference<"mutation">("catalog:approveReviewedStock");
const recentSyncRuns = makeFunctionReference<"query">("observability:recentSyncRuns");
const recentSignals = makeFunctionReference<"query">("observability:recentSignals");

const PRIMARY_URL = "https://primary.rpc.test";
const SECONDARY_URL = "https://secondary.rpc.test";
const CHAIN_ID = 8453;
const DEPLOYMENT_BLOCK = 100;
const VAULT: Address = "0x1000000000000000000000000000000000000001";
const VAULT_LOWER = VAULT.toLowerCase();
const OWNER: Address = "0x2000000000000000000000000000000000000002";
const RECIPIENT: Address = "0x3000000000000000000000000000000000000003";
const SENDER: Address = "0x4000000000000000000000000000000000000004";
const STOCK: Address = "0x5000000000000000000000000000000000000005";
const NOTE_HASH: Hex = `0x${"7".repeat(64)}`;
const RECEIVED_AT = Math.floor(Date.now() / 1_000) - 60;
const checkedMainnetManifest = deploymentRegistry[8453]!;

function blockHash(blockNumber: number, fork = 0) {
  return `0x${blockNumber.toString(16).padStart(32, "0")}${fork.toString(16).padStart(32, "0")}`;
}

function txHash(seed: number) {
  return `0x${seed.toString(16).padStart(64, "0")}` as Hash;
}

type World = {
  chainId: number;
  safeBlock: number;
  forkDefault: number;
  forkAt: Map<number, number>;
  missingBlocks: Set<number>;
  failing: Set<string>;
  vaultLogs: VaultEventLog[];
  receipts: Map<string, ChainReceipt>;
  creations: FactoryCreationLog[];
  identities: Map<string, TokenIdentity>;
  initialized: Set<string>;
  escrowed: Map<string, bigint>;
  balances: Map<string, bigint>;
};

function createWorld(overrides: Partial<World> = {}): World {
  return {
    chainId: CHAIN_ID,
    safeBlock: 5_000,
    forkDefault: 0,
    forkAt: new Map(),
    missingBlocks: new Set(),
    failing: new Set(),
    vaultLogs: [],
    receipts: new Map(),
    creations: [],
    identities: new Map(),
    initialized: new Set(),
    escrowed: new Map(),
    balances: new Map(),
    ...overrides,
  };
}

function rpcFor(world: World): ChainRpc {
  const guard = (name: string) => {
    if (world.failing.has(name)) throw new Error(`rpc-failure-${name}`);
  };
  const forkOf = (blockNumber: number) => world.forkAt.get(blockNumber) ?? world.forkDefault;
  return {
    getChainId: async () => {
      guard("getChainId");
      return world.chainId;
    },
    getSafeBlock: async () => {
      guard("getSafeBlock");
      return {
        number: BigInt(world.safeBlock),
        hashLower: blockHash(world.safeBlock, forkOf(world.safeBlock)),
      };
    },
    getBlock: async (blockNumber) => {
      guard("getBlock");
      const asNumber = Number(blockNumber);
      if (world.missingBlocks.has(asNumber)) return null;
      return { number: blockNumber, hashLower: blockHash(asNumber, forkOf(asNumber)) };
    },
    getTransactionReceipt: async (hash) => {
      guard("getTransactionReceipt");
      const receipt = world.receipts.get(hash.toLowerCase());
      if (!receipt) throw new Error("receipt-not-found");
      return receipt;
    },
    getVaultEvents: async ({ fromBlock, toBlock }) => {
      guard("getVaultEvents");
      return world.vaultLogs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
    getFactoryCreations: async ({ fromBlock, toBlock }) => {
      guard("getFactoryCreations");
      return world.creations.filter(
        (creation) => creation.blockNumber >= fromBlock && creation.blockNumber <= toBlock,
      );
    },
    readTokenIdentity: async (token) => {
      guard("readTokenIdentity");
      const identity = world.identities.get(token.toLowerCase());
      if (!identity) throw new Error("identity-not-found");
      return identity;
    },
    readIsInitializedB20: async (_factory, token) => {
      guard("readIsInitializedB20");
      return world.initialized.has(token.toLowerCase());
    },
    readTotalEscrowed: async (_vault, stock) => {
      guard("readTotalEscrowed");
      const value = world.escrowed.get(stock.toLowerCase());
      if (value === undefined) throw new Error("escrow-not-found");
      return value;
    },
    readTokenBalance: async (token) => {
      guard("readTokenBalance");
      const value = world.balances.get(token.toLowerCase());
      if (value === undefined) throw new Error("balance-not-found");
      return value;
    },
  };
}

type CreatedArgs = {
  giftId: bigint;
  sender: Address;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
  noteHash: Hex;
};
type ClaimedArgs = { giftId: bigint; recipient: Address; stock: Address; amountRaw: bigint };

function encodeVaultEvent(eventName: "GiftCreated" | "GiftClaimed", args: CreatedArgs | ClaimedArgs) {
  const definition = sowmorrowVaultAbi.find(
    (entry) => entry.type === "event" && entry.name === eventName,
  ) as { inputs: ReadonlyArray<{ name: string; type: string; indexed: boolean }> };
  const values = args as unknown as Record<string, unknown>;
  const nonIndexed = definition.inputs.filter((input) => !input.indexed);
  return {
    topics: encodeEventTopics({
      abi: sowmorrowVaultAbi,
      eventName,
      args: values,
    } as never) as readonly Hex[],
    data: encodeAbiParameters(nonIndexed as never, nonIndexed.map((input) => values[input.name]) as never),
  };
}

function pushVaultEvent(
  world: World,
  input: {
    eventName: "GiftCreated" | "GiftClaimed";
    args: CreatedArgs | ClaimedArgs;
    blockNumber: number;
    fork?: number;
    transactionIndex?: number;
    logIndex?: number;
    seed?: number;
    receipt?: Partial<ChainReceipt>;
    emitter?: string;
  },
) {
  const { topics, data } = encodeVaultEvent(input.eventName, input.args);
  const transactionHash = txHash(input.seed ?? input.blockNumber);
  const blockHashHex = blockHash(input.blockNumber, input.fork ?? 0) as Hash;
  const log: VaultEventLog = {
    eventName: input.eventName,
    transactionHash,
    transactionIndex: input.transactionIndex ?? 0,
    logIndex: input.logIndex ?? 0,
    blockNumber: BigInt(input.blockNumber),
    blockHash: blockHashHex,
    topics,
    data,
  };
  world.vaultLogs.push(log);
  world.receipts.set(transactionHash.toLowerCase(), {
    status: "success",
    transactionHash,
    transactionIndex: log.transactionIndex,
    blockNumber: log.blockNumber,
    blockHash: blockHashHex,
    logs: [{ address: input.emitter ?? VAULT, logIndex: log.logIndex, topics, data }],
    ...input.receipt,
  });
  return log;
}

function createdArgs(overrides: Partial<CreatedArgs> = {}): CreatedArgs {
  return {
    giftId: 1n,
    sender: SENDER,
    recipient: RECIPIENT,
    stock: STOCK,
    amountRaw: 1_000n,
    unlockAt: 1_900_000_000n,
    noteHash: NOTE_HASH,
    ...overrides,
  };
}

function tipEventInput(overrides: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN_ID,
    vaultAddressLower: VAULT_LOWER,
    transactionHashLower: txHash(4_500).toLowerCase(),
    transactionIndex: 0,
    logIndex: 0,
    blockNumber: 4_500,
    blockHashLower: blockHash(4_500, 0),
    eventName: "GiftCreated",
    giftIdDecimal: "1",
    senderLower: SENDER.toLowerCase(),
    recipientLower: RECIPIENT.toLowerCase(),
    stockLower: STOCK.toLowerCase(),
    amountRawDecimal: "1000",
    unlockAt: 1_900_000_000,
    noteHashLower: NOTE_HASH,
    canonicality: "tip",
    source: "webhook",
    observedAt: 1_800_000_000,
    ...overrides,
  };
}

function activateManifest() {
  deploymentRegistry[8453] = {
    ...checkedMainnetManifest,
    status: "active",
    vaultAddress: VAULT,
    deploymentBlock: DEPLOYMENT_BLOCK,
    runtimeBytecodeHash: `0x${"1".repeat(64)}`,
    owner: { kind: "safe", address: OWNER },
  };
}

let world: World;

beforeEach(() => {
  world = createWorld();
  rpcRegistry.clear();
  rpcRegistry.set(PRIMARY_URL, rpcFor(world));
  process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID = "8453";
  process.env.SOWMORROW_BASE_MAINNET_RPC_URL = PRIMARY_URL;
  delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY;
  delete process.env.SOWMORROW_INDEXER_ENABLED;
  activateManifest();
});

afterEach(() => {
  delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
  delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL;
  delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY;
  delete process.env.SOWMORROW_INDEXER_ENABLED;
  deploymentRegistry[8453] = checkedMainnetManifest;
});

function enableBackfill() {
  process.env.SOWMORROW_INDEXER_ENABLED = "true";
}

describe("configured vault reconciliation", () => {
  it("returns not_configured without a selected deployment chain", async () => {
    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    const t = convexTest(schema, modules);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "not_configured" });
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toHaveLength(0);
  });

  it("returns not_configured without a primary RPC url", async () => {
    delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL;
    const t = convexTest(schema, modules);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "not_configured" });
  });

  it("records a chain mismatch instead of indexing another network", async () => {
    world.chainId = 84532;
    const t = convexTest(schema, modules);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "chain_mismatch" });
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toMatchObject([{ pipeline: "vault-events", outcome: "chain_mismatch" }]);
  });

  it("records a typed rpc failure instead of swallowing the error", async () => {
    world.failing.add("getSafeBlock");
    const t = convexTest(schema, modules);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "rpc_failure" });
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toMatchObject([{ outcome: "failed", errorCode: "rpc_failure" }]);
  });

  it("promotes a tip event to safe whenever ingestion runs, with the backfill flag off", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, tipEventInput());

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "tip_only",
      promoted: 1,
      orphaned: 0,
    });

    const events = await t.run((ctx) => ctx.db.query("chainEvents").collect());
    expect(events).toMatchObject([{ canonicality: "safe" }]);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toMatchObject([{ outcome: "promoted_tip_events", safeHeadBlock: 5_000 }]);
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { nextBlock: DEPLOYMENT_BLOCK, state: "active", checkpoints: [] },
    ]);
    expect(await t.run((ctx) => ctx.db.query("deployments").collect())).toMatchObject([
      { chainId: CHAIN_ID, vaultAddressLower: VAULT_LOWER, active: true },
    ]);
  });

  it("orphans a tip event whose block hash no longer matches and rolls the gift back", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, tipEventInput());
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(1);

    world.forkAt.set(4_500, 9);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "tip_only",
      promoted: 0,
      orphaned: 1,
    });

    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "orphaned" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(0);
  });

  it("indexes a bounded range, stores a checkpoint, and records the active deployment", async () => {
    enableBackfill();
    pushVaultEvent(world, { eventName: "GiftCreated", args: createdArgs(), blockNumber: 150 });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "indexed",
      events: 1,
      throughBlock: 2_099,
    });

    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toMatchObject([
      { giftIdDecimal: "1", state: "active", createdBlock: 150, createdCanonicality: "safe" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      {
        nextBlock: 2_100,
        lastCommittedBlock: 2_099,
        lastCommittedBlockHashLower: blockHash(2_099),
        checkpoints: [{ blockNumber: 2_099, blockHashLower: blockHash(2_099) }],
      },
    ]);
    expect(await t.run((ctx) => ctx.db.query("deployments").collect())).toMatchObject([
      { chainId: CHAIN_ID, vaultAddressLower: VAULT_LOWER, active: true, deploymentBlock: DEPLOYMENT_BLOCK },
    ]);
  });

  it("orders a claim after its create across transactions in the same range", async () => {
    enableBackfill();
    pushVaultEvent(world, {
      eventName: "GiftClaimed",
      args: { giftId: 1n, recipient: RECIPIENT, stock: STOCK, amountRaw: 1_000n },
      blockNumber: 160,
      seed: 2,
      transactionIndex: 1,
    });
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 150,
      seed: 1,
      transactionIndex: 0,
    });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toMatchObject({
      operation: "indexed",
      events: 2,
    });
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toMatchObject([
      { state: "claimed", projectionVersion: 2 },
    ]);
  });

  it("refuses to index a log whose receipt reverted", async () => {
    enableBackfill();
    const log = pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 150,
    });
    const receipt = world.receipts.get(log.transactionHash.toLowerCase())!;
    world.receipts.set(log.transactionHash.toLowerCase(), { ...receipt, status: "reverted" });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "log_unproven",
      errorCode: "receipt_failed",
    });
    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { nextBlock: DEPLOYMENT_BLOCK },
    ]);
  });

  it("refuses to index a log the receipt does not carry from the vault", async () => {
    enableBackfill();
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 150,
      emitter: "0x9999999999999999999999999999999999999999",
    });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "log_unproven",
      errorCode: "receipt_mismatch",
    });
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toMatchObject([{ outcome: "failed", errorCode: "receipt_mismatch" }]);
  });

  it("refuses to index a log whose receipt payload disagrees with the provider log", async () => {
    enableBackfill();
    const log = pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 150,
    });
    const receipt = world.receipts.get(log.transactionHash.toLowerCase())!;
    world.receipts.set(log.transactionHash.toLowerCase(), {
      ...receipt,
      logs: [{ ...receipt.logs[0], data: `0x${"0".repeat(receipt.logs[0].data.length - 2)}` }],
    });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "log_unproven",
      errorCode: "receipt_mismatch",
    });
  });

  it("refuses to index a log whose receipt block hash disagrees", async () => {
    enableBackfill();
    const log = pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 150,
    });
    const receipt = world.receipts.get(log.transactionHash.toLowerCase())!;
    world.receipts.set(log.transactionHash.toLowerCase(), {
      ...receipt,
      blockHash: blockHash(150, 4) as Hash,
    });
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "log_unproven",
      errorCode: "receipt_mismatch",
    });
  });

  it("reports an rpc failure while fetching a range receipt", async () => {
    enableBackfill();
    pushVaultEvent(world, { eventName: "GiftCreated", args: createdArgs(), blockNumber: 150 });
    world.failing.add("getTransactionReceipt");
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "rpc_failure" });
  });

  it("reports an rpc failure while reading the range logs", async () => {
    enableBackfill();
    world.failing.add("getVaultEvents");
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "rpc_failure" });
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([
      { outcome: "failed", errorCode: "rpc_failure", fromBlock: DEPLOYMENT_BLOCK, toBlock: 2_099 },
    ]);
  });

  it("stops before advancing when the range end block hash is unavailable", async () => {
    enableBackfill();
    world.missingBlocks.add(2_099);
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "missing_end_block_hash",
    });
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { nextBlock: DEPLOYMENT_BLOCK },
    ]);
  });

  it("reports caught_up once the cursor reaches the safe head", async () => {
    enableBackfill();
    world.safeBlock = 120;
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toMatchObject({ operation: "indexed" });
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "caught_up" });
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([
      { outcome: "indexed" },
      { outcome: "caught_up" },
    ]);
  });

  it("stops while the cursor is halted", async () => {
    enableBackfill();
    const t = convexTest(schema, modules);
    await t.mutation(initializeCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      deploymentBlock: DEPLOYMENT_BLOCK,
      now: 1_800_000_000,
    });
    await t.mutation(haltCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      failureCode: "cursor_hash_mismatch",
      now: 1_800_000_000,
    });

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "halted" });
  });
});

describe("reorg rewind", () => {
  async function indexThroughSafeHead(t: ReturnType<typeof convexTest>) {
    world.safeBlock = 5_000;
    await t.action(reconcileConfiguredVault, {});
    await t.action(reconcileConfiguredVault, {});
    await t.action(reconcileConfiguredVault, {});
  }

  it("walks back to a stored checkpoint, orphans later events, and resumes", async () => {
    enableBackfill();
    pushVaultEvent(world, { eventName: "GiftCreated", args: createdArgs(), blockNumber: 4_500 });
    const t = convexTest(schema, modules);
    await indexThroughSafeHead(t);

    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { nextBlock: 5_001, lastCommittedBlock: 5_000 },
    ]);
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(1);

    world.forkAt.set(5_000, 1);
    world.forkAt.set(4_500, 1);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "rewound",
      ancestorBlock: 4_099,
      orphanedEvents: 1,
    });

    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "orphaned" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      {
        nextBlock: 4_100,
        lastCommittedBlock: 4_099,
        lastCommittedBlockHashLower: blockHash(4_099),
        state: "active",
      },
    ]);
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([
      { outcome: "indexed" },
      { outcome: "indexed" },
      { outcome: "indexed" },
      { outcome: "rewound", toBlock: 4_099 },
    ]);
  });

  it("reincludes a rewound event at its new block on the next pass", async () => {
    enableBackfill();
    pushVaultEvent(world, { eventName: "GiftCreated", args: createdArgs(), blockNumber: 4_500 });
    const t = convexTest(schema, modules);
    await indexThroughSafeHead(t);

    world.forkAt.set(5_000, 1);
    world.forkAt.set(4_500, 1);
    await t.action(reconcileConfiguredVault, {});

    world.vaultLogs = [];
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_600,
      fork: 1,
      seed: 77,
    });
    world.forkAt.set(4_600, 1);
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toMatchObject({
      operation: "indexed",
      events: 1,
    });

    const events = await t.run((ctx) => ctx.db.query("chainEvents").collect());
    expect(events.map((event) => event.canonicality).sort()).toEqual(["orphaned", "safe"]);
    expect(await t.run((ctx) => ctx.db.query("gifts").collect())).toMatchObject([
      { createdBlock: 4_600, createdCanonicality: "safe" },
    ]);
  });

  it("halts with a typed reason when no checkpoint survives the reorg", async () => {
    enableBackfill();
    const t = convexTest(schema, modules);
    await indexThroughSafeHead(t);

    world.forkDefault = 3;
    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "halted_beyond_checkpoints",
    });

    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { state: "halted", failureCode: "reorg_beyond_checkpoints" },
    ]);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs[runs.length - 1]).toMatchObject({ outcome: "halted", errorCode: "reorg_beyond_checkpoints" });
  });

  it("reports an rpc failure while verifying the committed block", async () => {
    enableBackfill();
    const t = convexTest(schema, modules);
    await t.action(reconcileConfiguredVault, {});
    world.failing.add("getBlock");

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "rpc_failure" });
  });

  it("treats a pruned committed block as a reorg and rewinds", async () => {
    enableBackfill();
    const t = convexTest(schema, modules);
    await indexThroughSafeHead(t);
    world.missingBlocks.add(5_000);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toMatchObject({
      operation: "rewound",
      ancestorBlock: 4_099,
    });
  });

  it("keeps at most sixty-four checkpoints on the cursor", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(initializeCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      deploymentBlock: 0,
      now: 1_800_000_000,
    });
    for (let index = 0; index < 70; index += 1) {
      await t.mutation(advanceCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        expectedNextBlock: index === 0 ? 0 : index,
        committedBlock: index,
        committedBlockHashLower: blockHash(index),
        now: 1_800_000_000 + index,
      });
    }
    const cursor = await t.run((ctx) => ctx.db.query("indexerCursors").unique());
    expect(cursor?.checkpoints).toHaveLength(64);
    expect(cursor?.checkpoints[0]).toEqual({ blockNumber: 6, blockHashLower: blockHash(6) });
  });
});

describe("cursor compare-and-set and operator repair", () => {
  async function seedCursor(t: ReturnType<typeof convexTest>) {
    await t.mutation(initializeCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      deploymentBlock: DEPLOYMENT_BLOCK,
      now: 1_800_000_000,
    });
    await t.mutation(advanceCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      expectedNextBlock: DEPLOYMENT_BLOCK,
      committedBlock: 200,
      committedBlockHashLower: blockHash(200),
      now: 1_800_000_001,
    });
  }

  it("rejects an advance from an unexpected next block", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    await expect(
      t.mutation(advanceCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        expectedNextBlock: DEPLOYMENT_BLOCK,
        committedBlock: 300,
        committedBlockHashLower: blockHash(300),
        now: 1_800_000_002,
      }),
    ).rejects.toThrow();
  });

  it("returns cursor_conflict when a competing writer moved the cursor first", async () => {
    enableBackfill();
    const t = convexTest(schema, modules);
    await t.mutation(initializeCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      deploymentBlock: DEPLOYMENT_BLOCK,
      now: 1_800_000_000,
    });
    const rpc = rpcFor(world);
    rpcRegistry.set(PRIMARY_URL, {
      ...rpc,
      getVaultEvents: async () => {
        await t.mutation(advanceCursor, {
          pipeline: "vault-events",
          chainId: CHAIN_ID,
          contractAddressLower: VAULT_LOWER,
          expectedNextBlock: DEPLOYMENT_BLOCK,
          committedBlock: 500,
          committedBlockHashLower: blockHash(500),
          now: 1_800_000_001,
        });
        return [];
      },
    });

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "cursor_conflict" });
  });

  it("rejects an invalid block number, hash, or operator identity", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    await expect(
      t.mutation(rewindCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        ancestorBlock: -1,
        ancestorBlockHashLower: blockHash(1),
        now: 1_800_000_002,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(rewindCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        ancestorBlock: 1,
        ancestorBlockHashLower: "0xnothash",
        now: 1_800_000_002,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(resumeHaltedCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "",
        now: 1_800_000_002,
      }),
    ).rejects.toThrow();
  });

  it("reports a missing cursor for rewind and resume", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(rewindCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        ancestorBlock: 1,
        ancestorBlockHashLower: blockHash(1),
        now: 1_800_000_002,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(resumeHaltedCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        resetToBlock: 1,
        resetToBlockHashLower: blockHash(1),
        operator: "reviewer-a",
        now: 1_800_000_002,
      }),
    ).resolves.toEqual({ operation: "missing" });
    await expect(
      t.mutation(haltCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        failureCode: "cursor_hash_mismatch",
        now: 1_800_000_002,
      }),
    ).resolves.toEqual({ operation: "missing" });
  });

  it("refuses to resume an active cursor or an unknown checkpoint", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    await expect(
      t.mutation(resumeHaltedCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
        now: 1_800_000_002,
      }),
    ).resolves.toEqual({ operation: "not_halted" });

    await t.mutation(haltCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      failureCode: "reorg_beyond_checkpoints",
      now: 1_800_000_003,
    });
    await expect(
      t.mutation(resumeHaltedCursor, {
        pipeline: "vault-events",
        chainId: CHAIN_ID,
        contractAddressLower: VAULT_LOWER,
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200, 5),
        operator: "reviewer-a",
        now: 1_800_000_004,
      }),
    ).rejects.toThrow();
  });

  it("resumes a halted cursor only with the exact block number and hash it resets to", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    await t.mutation(applyCanonicalVaultLog, tipEventInput({ canonicality: "safe" }));
    await t.mutation(haltCursor, {
      pipeline: "vault-events",
      chainId: CHAIN_ID,
      contractAddressLower: VAULT_LOWER,
      failureCode: "reorg_beyond_checkpoints",
      now: 1_800_000_003,
    });
    await expect(
      t.mutation(applyCanonicalVaultLog, tipEventInput({ canonicality: "safe" })),
    ).rejects.toThrow();

    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200, 6),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "reset_hash_mismatch" });

    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "resumed", orphanedEvents: 1 });

    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toMatchObject([
      { state: "active", nextBlock: 201, repairedBy: "reviewer-a" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "orphaned" },
    ]);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toMatchObject([
      { pipeline: "operator-repair", outcome: "completed", operator: "reviewer-a" },
    ]);
  });

  it("reports repair preconditions from the chain and configuration", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    world.failing.add("getBlock");
    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "rpc_failure" });

    world.failing.delete("getBlock");
    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "not_halted" });

    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "not_configured" });
  });

  it("keeps a missing block from being treated as a repair target", async () => {
    const t = convexTest(schema, modules);
    await seedCursor(t);
    world.missingBlocks.add(200);
    await expect(
      t.action(repairHaltedCursor, {
        resetToBlock: 200,
        resetToBlockHashLower: blockHash(200),
        operator: "reviewer-a",
      }),
    ).resolves.toEqual({ operation: "reset_hash_mismatch" });
  });
});

describe("secondary provider agreement", () => {
  it("indexes when both providers agree on the safe head hash", async () => {
    enableBackfill();
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY = SECONDARY_URL;
    rpcRegistry.set(SECONDARY_URL, rpcFor(world));
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toMatchObject({ operation: "indexed" });
  });

  it("records a provider_split signal and does not promote on disagreement", async () => {
    enableBackfill();
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY = SECONDARY_URL;
    const disagreeing = createWorld({ forkDefault: 2 });
    rpcRegistry.set(SECONDARY_URL, rpcFor(disagreeing));
    const t = convexTest(schema, modules);
    await t.mutation(applyCanonicalVaultLog, tipEventInput());

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "provider_split",
      blockNumber: 5_000,
    });

    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "tip" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("indexerCursors").collect())).toHaveLength(0);
    const signals = await t.query(recentSignals, { chainId: CHAIN_ID, limit: 50 });
    expect(signals).toMatchObject([
      {
        signal: {
          kind: "provider_split",
          blockNumber: 5_000,
          primaryBlockHashLower: blockHash(5_000, 0),
          secondaryBlockHashLower: blockHash(5_000, 2),
        },
      },
    ]);
    const runs = await t.query(recentSyncRuns, { chainId: CHAIN_ID, limit: 10 });
    expect(runs).toMatchObject([{ outcome: "provider_split", errorCode: "provider_disagreement" }]);
  });

  it("records a provider_split when the secondary cannot serve the safe head block", async () => {
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY = SECONDARY_URL;
    const pruned = createWorld();
    pruned.missingBlocks.add(5_000);
    rpcRegistry.set(SECONDARY_URL, rpcFor(pruned));
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({
      operation: "provider_split",
      blockNumber: 5_000,
    });
  });

  it("reports an rpc failure when the secondary provider is unreachable", async () => {
    process.env.SOWMORROW_BASE_MAINNET_RPC_URL_SECONDARY = SECONDARY_URL;
    const unreachable = createWorld();
    unreachable.failing.add("getBlock");
    rpcRegistry.set(SECONDARY_URL, rpcFor(unreachable));
    const t = convexTest(schema, modules);

    await expect(t.action(reconcileConfiguredVault, {})).resolves.toEqual({ operation: "rpc_failure" });
  });
});

describe("webhook delivery reconciliation", () => {
  const deliveryId = "evt_reconcile";

  async function recordDelivery(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
    await t.mutation(recordVerifiedDelivery, {
      deliveryId,
      bodyHash: `0x${"a".repeat(64)}`,
      receivedAt: RECEIVED_AT,
      chainId: CHAIN_ID,
      vaultAddressLower: VAULT_LOWER,
      transactionHashLower: txHash(4_800).toLowerCase(),
      logIndex: 0,
      blockNumber: 4_800,
      eventName: "GiftCreated",
      ...overrides,
    });
  }

  it("applies a proven delivery as safe and completes it", async () => {
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    const t = convexTest(schema, modules);
    await recordDelivery(t);

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({ operation: "inserted" });
    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "safe", seenViaWebhook: true },
    ]);
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").unique())).toMatchObject({
      processingStatus: "applied",
    });
  });

  it("marks a delivery above the safe head as a tip observation", async () => {
    world.safeBlock = 4_700;
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    const t = convexTest(schema, modules);
    await recordDelivery(t);

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({ operation: "inserted" });
    expect(await t.run((ctx) => ctx.db.query("chainEvents").collect())).toMatchObject([
      { canonicality: "tip" },
    ]);
  });

  it("fails a delivery for a chain without a configured RPC url", async () => {
    delete process.env.SOWMORROW_BASE_MAINNET_RPC_URL;
    const t = convexTest(schema, modules);
    await recordDelivery(t);

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({
      operation: "failed",
      failureCode: "configuration",
    });
  });

  it("retries a transient RPC failure with bounded backoff and then exhausts", async () => {
    world.failing.add("getChainId");
    const t = convexTest(schema, modules);
    await recordDelivery(t);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await t.action(reconcileDelivery, { deliveryId });
      if (attempt < 4) expect(result).toMatchObject({ operation: "retry_scheduled" });
      else expect(result).toMatchObject({ operation: "failed", failureCode: "rpc_failure" });
      await t.run(async (ctx) => {
        const delivery = await ctx.db.query("webhookDeliveries").unique();
        if (delivery && delivery.processingStatus === "pending") {
          await ctx.db.patch(delivery._id, { nextAttemptAt: 0, leaseUntil: undefined });
        }
      });
    }
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").unique())).toMatchObject({
      processingStatus: "failed",
      failureCode: "rpc_failure",
      attempts: 5,
    });
    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({
      operation: "already_processed",
    });
  });

  it("refuses to claim a delivery that already reached the attempt ceiling", async () => {
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    await t.run(async (ctx) => {
      const delivery = await ctx.db.query("webhookDeliveries").unique();
      await ctx.db.patch(delivery!._id, { attempts: 5, processingStatus: "pending", nextAttemptAt: 0 });
    });

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({ operation: "exhausted" });
    expect(await t.run((ctx) => ctx.db.query("webhookDeliveries").unique())).toMatchObject({
      processingStatus: "failed",
      failureCode: "attempts_exhausted",
      attempts: 5,
    });
  });

  it("defers a claim that is not yet due and reschedules it", async () => {
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    await t.run(async (ctx) => {
      const delivery = await ctx.db.query("webhookDeliveries").unique();
      await ctx.db.patch(delivery!._id, { nextAttemptAt: Math.floor(Date.now() / 1_000) + 120 });
    });

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({ operation: "deferred" });
  });

  it("returns already_processed for an unknown delivery id", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(reconcileDelivery, { deliveryId: "missing" })).resolves.toEqual({
      operation: "already_processed",
    });
  });

  it("rejects a delivery whose provider reports a different chain", async () => {
    world.chainId = 84532;
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({
      operation: "failed",
      failureCode: "receipt_mismatch",
    });
  });

  it("rejects a reverted receipt, a wrong block, a missing log, and a wrong event", async () => {
    const t = convexTest(schema, modules);
    const log = pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    const key = log.transactionHash.toLowerCase();
    const receipt = world.receipts.get(key)!;

    world.receipts.set(key, { ...receipt, status: "reverted" });
    await recordDelivery(t, { deliveryId: "d1" });
    await expect(t.action(reconcileDelivery, { deliveryId: "d1" })).resolves.toEqual({
      operation: "failed",
      failureCode: "receipt_failed",
    });

    world.receipts.set(key, { ...receipt, blockNumber: 4_801n });
    await recordDelivery(t, { deliveryId: "d2", bodyHash: `0x${"b".repeat(64)}` });
    await expect(t.action(reconcileDelivery, { deliveryId: "d2" })).resolves.toEqual({
      operation: "failed",
      failureCode: "receipt_mismatch",
    });

    world.receipts.set(key, { ...receipt, logs: [] });
    await recordDelivery(t, { deliveryId: "d3", bodyHash: `0x${"c".repeat(64)}` });
    await expect(t.action(reconcileDelivery, { deliveryId: "d3" })).resolves.toEqual({
      operation: "failed",
      failureCode: "log_missing",
    });

    world.receipts.set(key, {
      ...receipt,
      logs: [{ ...receipt.logs[0], topics: [`0x${"e".repeat(64)}`], data: "0x" }],
    });
    await recordDelivery(t, { deliveryId: "d4", bodyHash: `0x${"d".repeat(64)}` });
    await expect(t.action(reconcileDelivery, { deliveryId: "d4" })).resolves.toEqual({
      operation: "failed",
      failureCode: "log_decode_failed",
    });

    const claimed = encodeVaultEvent("GiftClaimed", {
      giftId: 1n,
      recipient: RECIPIENT,
      stock: STOCK,
      amountRaw: 1_000n,
    });
    world.receipts.set(key, {
      ...receipt,
      logs: [{ ...receipt.logs[0], topics: claimed.topics, data: claimed.data }],
    });
    await recordDelivery(t, { deliveryId: "d5", bodyHash: `0x${"f".repeat(64)}` });
    await expect(t.action(reconcileDelivery, { deliveryId: "d5" })).resolves.toEqual({
      operation: "failed",
      failureCode: "receipt_mismatch",
    });
  });

  it("rejects a receipt whose canonical block hash no longer matches", async () => {
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    world.forkAt.set(4_800, 4);
    const t = convexTest(schema, modules);
    await recordDelivery(t);

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({
      operation: "failed",
      failureCode: "receipt_mismatch",
    });
  });

  it("retries when the receipt lookup itself fails", async () => {
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toMatchObject({
      operation: "retry_scheduled",
      failureCode: "rpc_failure",
    });
  });

  it("retries when the canonical block read fails", async () => {
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    world.failing.add("getSafeBlock");

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toMatchObject({
      operation: "retry_scheduled",
      failureCode: "rpc_failure",
    });
  });

  it("fails a delivery whose projection conflicts with a stored event", async () => {
    pushVaultEvent(world, {
      eventName: "GiftCreated",
      args: createdArgs(),
      blockNumber: 4_800,
      seed: 4_800,
    });
    const t = convexTest(schema, modules);
    await t.mutation(
      applyCanonicalVaultLog,
      tipEventInput({
        transactionHashLower: txHash(4_800).toLowerCase(),
        blockNumber: 4_800,
        blockHashLower: blockHash(4_800, 0),
        amountRawDecimal: "999",
        canonicality: "safe",
      }),
    );
    await recordDelivery(t);

    await expect(t.action(reconcileDelivery, { deliveryId })).resolves.toEqual({
      operation: "failed",
      failureCode: "event_conflict",
    });
  });

  it("schedules every due delivery from the sweeper", async () => {
    const t = convexTest(schema, modules);
    await recordDelivery(t);
    await expect(t.action(retryDueDeliveries, {})).resolves.toEqual({ scheduled: 1 });
  });
});

describe("B20 factory candidate discovery", () => {
  const token: Address = getAddress("0xb2000000000000000000006d5f9dcf13ce5cf39c");

  function pushCreation(overrides: Partial<FactoryCreationLog> = {}) {
    const creation: FactoryCreationLog = {
      token,
      variant: 0,
      name: "Onchain Apple",
      symbol: "AAPLc",
      decimals: 18,
      creator: SENDER,
      transactionHash: txHash(300),
      logIndex: 2,
      blockNumber: 300n,
      blockHash: blockHash(300) as Hash,
      ...overrides,
    };
    world.creations.push(creation);
    world.initialized.add(creation.token.toLowerCase());
    world.identities.set(creation.token.toLowerCase(), {
      name: creation.name,
      symbol: creation.symbol,
      decimals: creation.decimals,
    });
    return creation;
  }

  it("quarantines a newly created asset token with its on-chain evidence", async () => {
    pushCreation();
    const t = convexTest(schema, modules);

    await expect(t.action(scanFactoryCandidates, {})).resolves.toMatchObject({
      operation: "scanned",
      quarantined: 1,
      rejected: 0,
      throughBlock: 2_099,
    });

    expect(await t.run((ctx) => ctx.db.query("stockCandidates").collect())).toMatchObject([
      {
        addressLower: token.toLowerCase(),
        addressChecksum: getAddress(token),
        creationBlock: 300,
        creationLogIndex: 2,
        observedSymbol: "AAPLc",
        observedVariant: "asset",
        reviewDisposition: "unreviewed",
      },
    ]);
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toHaveLength(0);
    await expect(t.action(scanFactoryCandidates, {})).resolves.toMatchObject({
      operation: "scanned",
      quarantined: 0,
      throughBlock: 4_099,
    });
  });

  it("does not re-quarantine a token that is already reviewed", async () => {
    pushCreation();
    const t = convexTest(schema, modules);
    await t.mutation(proposeReviewedStock, {
      chainId: CHAIN_ID,
      addressChecksum: getAddress(token),
      intent: "verify",
      symbol: "AAPLc",
      name: "Apple",
      decimals: 18,
      b20Generation: "beryl",
      sortOrder: 0,
      evidenceUrl: "https://docs.base.org/",
      evidenceHash: "sha256:abc",
      reviewer: "reviewer-a",
      now: 1_800_000_000,
    });
    await t.mutation(approveReviewedStock, {
      chainId: CHAIN_ID,
      addressChecksum: getAddress(token),
      intent: "verify",
      evidenceHash: "sha256:abc",
      reviewer: "reviewer-b",
      now: 1_800_000_001,
    });

    await expect(t.action(scanFactoryCandidates, {})).resolves.toMatchObject({ quarantined: 0 });
    expect(await t.run((ctx) => ctx.db.query("stockCandidates").collect())).toHaveLength(0);
  });

  it("rejects a stablecoin variant, an uninitialized token, and a stale block hash", async () => {
    pushCreation({ variant: 1, token: getAddress("0xb20000000000000000000000000000000000000a") });
    const uninitialized = pushCreation({
      token: getAddress("0xb20000000000000000000000000000000000000b"),
      transactionHash: txHash(301),
    });
    world.initialized.delete(uninitialized.token.toLowerCase());
    pushCreation({
      token: getAddress("0xb20000000000000000000000000000000000000c"),
      transactionHash: txHash(302),
      blockHash: blockHash(300, 8) as Hash,
    });
    const t = convexTest(schema, modules);

    await expect(t.action(scanFactoryCandidates, {})).resolves.toMatchObject({
      operation: "scanned",
      quarantined: 0,
      rejected: 3,
    });
  });

  it("records a candidate seen twice without duplicating it", async () => {
    pushCreation();
    const t = convexTest(schema, modules);
    await t.action(scanFactoryCandidates, {});
    await t.run(async (ctx) => {
      const cursor = await ctx.db
        .query("indexerCursors")
        .filter((q) => q.eq(q.field("pipeline"), "factory-candidates"))
        .unique();
      await ctx.db.patch(cursor!._id, { nextBlock: 100, checkpoints: [] });
    });

    await expect(t.action(scanFactoryCandidates, {})).resolves.toMatchObject({ quarantined: 0 });
    expect(await t.run((ctx) => ctx.db.query("stockCandidates").collect())).toHaveLength(1);
  });

  it("reports typed discovery failures", async () => {
    const t = convexTest(schema, modules);

    world.chainId = 84532;
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "chain_mismatch" });
    world.chainId = CHAIN_ID;

    world.failing.add("getSafeBlock");
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "rpc_failure" });
    world.failing.delete("getSafeBlock");

    world.failing.add("getFactoryCreations");
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "rpc_failure" });
    world.failing.delete("getFactoryCreations");

    pushCreation();
    world.failing.add("readTokenIdentity");
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "rpc_failure" });
    world.failing.delete("readTokenIdentity");

    world.missingBlocks.add(2_099);
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({
      operation: "missing_end_block_hash",
    });
    world.missingBlocks.delete(2_099);

    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs.every((run) => run.pipeline === "factory-candidates")).toBe(true);
  });

  it("stops scanning while the discovery cursor is halted", async () => {
    const t = convexTest(schema, modules);
    await t.action(scanFactoryCandidates, {});
    const factoryLower = await t.run(async (ctx) => {
      const cursor = await ctx.db
        .query("indexerCursors")
        .filter((q) => q.eq(q.field("pipeline"), "factory-candidates"))
        .unique();
      await ctx.db.patch(cursor!._id, { state: "halted" });
      return cursor!.contractAddressLower;
    });
    expect(factoryLower).toMatch(/^0x[0-9a-f]{40}$/);

    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "halted" });
  });

  it("returns not_configured without a selected deployment", async () => {
    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    const t = convexTest(schema, modules);
    await expect(t.action(scanFactoryCandidates, {})).resolves.toEqual({ operation: "not_configured" });
  });
});

describe("solvency and lag monitor", () => {
  async function seedStock(t: ReturnType<typeof convexTest>) {
    for (const stock of deploymentRegistry[8453]!.stocks) {
      world.escrowed.set(stock.address.toLowerCase(), 0n);
      world.balances.set(stock.address.toLowerCase(), 0n);
    }
    await t.run(async (ctx) => {
      await ctx.db.insert("stocks", {
        chainId: CHAIN_ID,
        addressLower: STOCK.toLowerCase(),
        addressChecksum: getAddress(STOCK),
        symbol: "AAPLc",
        name: "Apple",
        decimals: 18,
        reviewStatus: "verified",
        reviewedSourceUrl: "https://docs.base.org/",
        reviewedSourceHash: "sha256:abc",
        reviewedAt: 1_800_000_000,
        b20Generation: "beryl",
        sortOrder: 0,
        vaultSupported: true,
      });
    });
  }

  it("records a healthy signal and the index lag", async () => {
    world.escrowed.set(STOCK.toLowerCase(), 1_000n);
    world.balances.set(STOCK.toLowerCase(), 1_500n);
    const t = convexTest(schema, modules);
    await seedStock(t);

    await expect(t.action(checkVaultSolvencyAndLag, {})).resolves.toMatchObject({
      operation: "checked",
      healthy: 14,
      insolvent: 0,
      unreadable: 0,
    });

    const signals = await t.query(recentSignals, { chainId: CHAIN_ID, limit: 50 });
    expect(signals).toEqual(
      expect.arrayContaining(
        [
          { signal: { kind: "lag", safeHeadBlock: 5_000, cursorBlock: 100, lagBlocks: 4_900 } },
          {
            signal: {
              kind: "solvency",
              status: "healthy",
              totalEscrowedDecimal: "1000",
              vaultBalanceDecimal: "1500",
            },
          },
        ].map((entry) => expect.objectContaining({ signal: expect.objectContaining(entry.signal) })),
      ),
    );
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([
      { pipeline: "solvency-monitor", outcome: "failed" },
    ]);
  });

  it("records an insolvent signal when the vault balance is below the escrowed total", async () => {
    world.escrowed.set(STOCK.toLowerCase(), 2_000n);
    world.balances.set(STOCK.toLowerCase(), 1n);
    const t = convexTest(schema, modules);
    await seedStock(t);

    await expect(t.action(checkVaultSolvencyAndLag, {})).resolves.toMatchObject({ insolvent: 1 });
    const signals = await t.query(recentSignals, { chainId: CHAIN_ID, limit: 50 });
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: expect.objectContaining({ kind: "solvency", status: "insolvent" }),
        }),
      ]),
    );
  });

  it("fails the run when a stock cannot be read", async () => {
    const t = convexTest(schema, modules);
    await seedStock(t);
    await expect(t.action(checkVaultSolvencyAndLag, {})).resolves.toMatchObject({ unreadable: 1 });
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([{ outcome: "failed" }]);
  });

  it("reports a typed failure when the safe head is unavailable", async () => {
    world.failing.add("getSafeBlock");
    const t = convexTest(schema, modules);
    await expect(t.action(checkVaultSolvencyAndLag, {})).resolves.toEqual({ operation: "rpc_failure" });
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toMatchObject([
      { pipeline: "solvency-monitor", outcome: "failed", errorCode: "rpc_failure" },
    ]);
  });

  it("returns not_configured without a selected deployment", async () => {
    delete process.env.SOWMORROW_DEPLOYMENT_CHAIN_ID;
    const t = convexTest(schema, modules);
    await expect(t.action(checkVaultSolvencyAndLag, {})).resolves.toEqual({ operation: "not_configured" });
  });

  it("reports the recorded deployment as unchanged on a repeat write", async () => {
    const t = convexTest(schema, modules);
    const args = {
      chainId: CHAIN_ID,
      network: "base-mainnet" as const,
      vaultAddressChecksum: VAULT,
      deploymentBlock: DEPLOYMENT_BLOCK,
      now: 1_800_000_000,
    };
    await expect(t.mutation(recordActiveDeployment, args)).resolves.toEqual({ operation: "inserted" });
    await expect(t.mutation(recordActiveDeployment, args)).resolves.toEqual({ operation: "unchanged" });
    await expect(
      t.mutation(recordActiveDeployment, { ...args, deploymentBlock: DEPLOYMENT_BLOCK + 1 }),
    ).resolves.toEqual({ operation: "updated" });
    await expect(
      t.mutation(recordActiveDeployment, { ...args, vaultAddressChecksum: VAULT.toUpperCase() }),
    ).rejects.toThrow();
  });
});

it("replays a halted cursor from the deployment boundary when all checkpoints are orphaned", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(initializeCursor, {
    pipeline: "vault-events",
    chainId: CHAIN_ID,
    contractAddressLower: VAULT_LOWER,
    deploymentBlock: DEPLOYMENT_BLOCK,
    now: RECEIVED_AT,
  });
  await t.mutation(haltCursor, {
    pipeline: "vault-events",
    chainId: CHAIN_ID,
    contractAddressLower: VAULT_LOWER,
    failureCode: "reorg_beyond_checkpoints",
    now: RECEIVED_AT,
  });
  const result = await t.action(repairHaltedCursor, {
    resetToBlock: DEPLOYMENT_BLOCK - 1,
    resetToBlockHashLower: blockHash(DEPLOYMENT_BLOCK - 1),
    operator: "test-operator",
  });
  expect(result.operation).toBe("resumed");
  const cursor = await t.run((ctx) => ctx.db.query("indexerCursors").unique());
  expect(cursor?.nextBlock).toBe(DEPLOYMENT_BLOCK);
});

it("keeps a large repair halted until every affected event is removed", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(initializeCursor, {
    pipeline: "vault-events",
    chainId: CHAIN_ID,
    contractAddressLower: VAULT_LOWER,
    deploymentBlock: DEPLOYMENT_BLOCK,
    now: RECEIVED_AT,
  });
  await t.run(async (ctx) => {
    for (let i = 0; i < 501; i++) {
      const { observedAt, source, ...event } = tipEventInput({
        giftIdDecimal: String(i + 1),
        transactionHashLower: txHash(i + 1),
      });
      expect(source).toBe("webhook");
      await ctx.db.insert("chainEvents", {
        ...event,
        eventName: "GiftCreated",
        canonicality: "tip",
        firstSeenAt: observedAt,
        lastVerifiedAt: observedAt,
        seenViaWebhook: true,
        seenViaReconciler: false,
      });
    }
  });
  await t.mutation(haltCursor, {
    pipeline: "vault-events",
    chainId: CHAIN_ID,
    contractAddressLower: VAULT_LOWER,
    failureCode: "reorg_beyond_checkpoints",
    now: RECEIVED_AT,
  });
  await t.run(async (ctx) => {
    const cursor = await ctx.db.query("indexerCursors").unique();
    await ctx.db.patch(cursor!._id, { checkpoints: [{ blockNumber: 200, blockHashLower: blockHash(200) }] });
  });
  const args = {
    resetToBlock: DEPLOYMENT_BLOCK - 1,
    resetToBlockHashLower: blockHash(DEPLOYMENT_BLOCK - 1),
    operator: "test-operator",
  };
  expect(await t.action(repairHaltedCursor, args)).toMatchObject({ operation: "cleanup_pending" });
  expect(await t.run((ctx) => ctx.db.query("indexerCursors").unique())).toMatchObject({ state: "halted" });
  expect(
    await t.action(repairHaltedCursor, { ...args, resetToBlock: 200, resetToBlockHashLower: blockHash(200) }),
  ).toMatchObject({ operation: "repair_boundary_conflict" });
  expect(await t.action(repairHaltedCursor, args)).toMatchObject({ operation: "resumed" });
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("chainEvents")
        .filter((q) => q.neq(q.field("canonicality"), "orphaned"))
        .collect(),
    ),
  ).toHaveLength(0);
  expect(
    await t.mutation(makeFunctionReference<"mutation">("events:setEventCanonicality"), {
      chainId: CHAIN_ID,
      vaultAddressLower: VAULT_LOWER,
      transactionHashLower: txHash(1),
      logIndex: 0,
      blockHashLower: blockHash(4500),
      canonicality: "orphaned",
      observedAt: RECEIVED_AT,
      requireHalted: true,
    }),
  ).toEqual({ operation: "recovery_finished" });
});
