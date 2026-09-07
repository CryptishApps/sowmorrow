import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const proposeReviewedStock = makeFunctionReference<"mutation">("catalog:proposeReviewedStock");
const approveReviewedStock = makeFunctionReference<"mutation">("catalog:approveReviewedStock");
const setVaultSupport = makeFunctionReference<"mutation">("catalog:setVaultSupport");
const quarantineCandidate = makeFunctionReference<"mutation">("catalog:quarantineCandidate");
const listCandidates = makeFunctionReference<"query">("catalog:listCandidates");
const listMonitoredStocks = makeFunctionReference<"query">("catalog:listMonitoredStocks");
const seedReviewedMainnet = makeFunctionReference<"mutation">("catalogSeed:seedReviewedMainnet");
const listVerified = makeFunctionReference<"query">("catalog:listVerified");
const pageVerified = makeFunctionReference<"query">("catalog:pageVerified");

const APPLE = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const AMAZON = "0xb200000000000000000000d9192b6B456483C2E8";
const COINBASE = "0xb200000000000000000000c85a31389D71F3ecfb";
const EVIDENCE_URL = "https://docs.base.org/specifications/b20/tokenized-stocks-on-base";
const EVIDENCE_HASH = "sha256:0f5e";

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    addressChecksum: APPLE,
    intent: "verify",
    symbol: "AAPLc",
    name: "Apple",
    decimals: 18,
    b20Generation: "beryl",
    sortOrder: 0,
    evidenceUrl: EVIDENCE_URL,
    evidenceHash: EVIDENCE_HASH,
    reviewer: "reviewer-a",
    now: 1_800_000_000,
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 8453,
    addressChecksum: APPLE,
    intent: "verify",
    evidenceHash: EVIDENCE_HASH,
    reviewer: "reviewer-b",
    now: 1_800_000_100,
    ...overrides,
  };
}

async function promote(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  const { vaultSupported, ...proposalOverrides } = overrides;
  await t.mutation(proposeReviewedStock, proposal(proposalOverrides));
  await t.mutation(
    approveReviewedStock,
    approval({
      chainId: overrides.chainId ?? 8453,
      addressChecksum: overrides.addressChecksum ?? APPLE,
      evidenceHash: overrides.evidenceHash ?? EVIDENCE_HASH,
    }),
  );
  await t.mutation(setVaultSupport, {
    chainId: (overrides.chainId as number) ?? 8453,
    addressLower: ((overrides.addressChecksum as string) ?? APPLE).toLowerCase(),
    vaultSupported: vaultSupported === undefined ? true : (vaultSupported as boolean),
    checkedAt: 1_800_000_200,
    checkedBlock: 100,
  });
}

describe("reviewed stock catalog", () => {
  it("seeds the checked source artifact idempotently with its review evidence", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(seedReviewedMainnet, {})).resolves.toEqual({ inserted: 13, updated: 0 });
    await expect(t.mutation(seedReviewedMainnet, {})).resolves.toEqual({ inserted: 0, updated: 13 });

    const documents = await t.run((ctx) => ctx.db.query("stocks").collect());
    expect(documents).toHaveLength(13);
    expect(documents.map((entry) => entry.symbol)).toContain("SPCXc");
    expect(documents.every((entry) => entry.reviewedSourceHash.length === 71)).toBe(true);
  });

  it("returns only verified, vault-supported records in reviewed rail order", async () => {
    const t = convexTest(schema, modules);
    await promote(t, { sortOrder: 2 });
    await promote(t, { addressChecksum: AMAZON, symbol: "AMZNc", name: "Amazon", sortOrder: 1 });
    await promote(t, {
      addressChecksum: COINBASE,
      symbol: "COINc",
      name: "Coinbase",
      sortOrder: 0,
      vaultSupported: false,
    });
    await promote(t, {
      chainId: 84532,
      addressChecksum: "0x1000000000000000000000000000000000000001",
      symbol: "TEST1",
      name: "Test asset",
      sortOrder: 0,
    });

    const result = await t.query(listVerified, { chainId: 8453 });
    expect(result.map((entry: { symbol: string }) => entry.symbol)).toEqual(["AMZNc", "AAPLc"]);
  });

  it("rejects an unknown chain id on every public catalog query", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(listVerified, { chainId: 1 })).rejects.toThrow();
    await expect(
      t.query(pageVerified, { chainId: 1, paginationOpts: { numItems: 5, cursor: null } }),
    ).rejects.toThrow();
  });

  it("clamps an unbounded page request to one hundred records", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(seedReviewedMainnet, {});
    const page = await t.query(pageVerified, {
      chainId: 8453,
      paginationOpts: { numItems: 100_000, cursor: null },
    });
    expect(page.page).toHaveLength(13);
    expect(page.isDone).toBe(true);

    const firstPage = await t.query(pageVerified, {
      chainId: 8453,
      paginationOpts: { numItems: 5, cursor: null },
    });
    expect(firstPage.page).toHaveLength(5);
    expect(firstPage.isDone).toBe(false);
  });
});

describe("two-reviewer promotion ceremony", () => {
  it("writes the reviewed row only after a second reviewer approves the same evidence", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(proposeReviewedStock, proposal())).resolves.toMatchObject({
      operation: "proposed",
    });
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toHaveLength(0);

    await expect(t.mutation(approveReviewedStock, approval())).resolves.toEqual({ operation: "verified" });
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toMatchObject([
      {
        addressLower: APPLE.toLowerCase(),
        reviewStatus: "verified",
        vaultSupported: "unknown",
        proposedBy: "reviewer-a",
        approvedBy: "reviewer-b",
      },
    ]);
    expect(await t.run((ctx) => ctx.db.query("stockPromotions").collect())).toMatchObject([
      { status: "approved", approvedBy: "reviewer-b" },
    ]);
  });

  it("refuses the same reviewer, a changed evidence hash, and a missing proposal", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(approveReviewedStock, approval())).rejects.toThrow();

    await t.mutation(proposeReviewedStock, proposal());
    await expect(t.mutation(approveReviewedStock, approval({ reviewer: "reviewer-a" }))).rejects.toThrow();
    await expect(
      t.mutation(approveReviewedStock, approval({ evidenceHash: "sha256:tampered" })),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toHaveLength(0);

    await t.mutation(approveReviewedStock, approval());
    await expect(t.mutation(approveReviewedStock, approval({ reviewer: "reviewer-c" }))).rejects.toThrow();
  });

  it("rejects malformed proposal input", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(proposeReviewedStock, proposal({ addressChecksum: APPLE.toLowerCase() })),
    ).rejects.toThrow();
    await expect(t.mutation(proposeReviewedStock, proposal({ reviewer: "" }))).rejects.toThrow();
    await expect(t.mutation(proposeReviewedStock, proposal({ evidenceUrl: "" }))).rejects.toThrow();
    await expect(t.mutation(proposeReviewedStock, proposal({ symbol: "" }))).rejects.toThrow();
    await expect(t.mutation(proposeReviewedStock, proposal({ decimals: 1.5 }))).rejects.toThrow();
    await expect(
      t.mutation(approveReviewedStock, approval({ addressChecksum: APPLE.toLowerCase() })),
    ).rejects.toThrow();
  });

  it("replaces an open proposal from the same reviewer pass", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(proposeReviewedStock, proposal());
    await expect(
      t.mutation(proposeReviewedStock, proposal({ name: "Apple Inc.", reviewer: "reviewer-z" })),
    ).resolves.toMatchObject({ operation: "replaced" });
    const promotions = await t.run((ctx) => ctx.db.query("stockPromotions").collect());
    expect(promotions).toMatchObject([{ name: "Apple Inc.", proposedBy: "reviewer-z" }]);
  });

  it("mirrors the ceremony for retirement and keeps observed vault support", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await expect(t.mutation(proposeReviewedStock, proposal({ intent: "retire" }))).resolves.toMatchObject({
      operation: "proposed",
    });
    await expect(t.mutation(approveReviewedStock, approval({ intent: "retire" }))).resolves.toEqual({
      operation: "retired",
    });
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toMatchObject([
      { reviewStatus: "retired", vaultSupported: true },
    ]);
    expect(await t.query(listVerified, { chainId: 8453 })).toHaveLength(0);
  });

  it("refuses to retire a stock that was never reviewed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(proposeReviewedStock, proposal({ intent: "retire" }));
    await expect(t.mutation(approveReviewedStock, approval({ intent: "retire" }))).rejects.toThrow();
  });

  it("reports a missing stock when refreshing vault support", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(setVaultSupport, {
        chainId: 8453,
        addressLower: APPLE.toLowerCase(),
        vaultSupported: true,
        checkedAt: 1,
        checkedBlock: 1,
      }),
    ).resolves.toEqual({ operation: "missing" });
  });
});

describe("quarantined stock candidates", () => {
  const candidate = {
    chainId: 8453,
    addressChecksum: APPLE,
    factoryAddressLower: "0xb20f000000000000000000000000000000000000",
    creatorAddressLower: "0x4000000000000000000000000000000000000004",
    creationTxHashLower: `0x${"1".repeat(64)}`,
    creationLogIndex: 2,
    creationBlock: 300,
    creationBlockHashLower: `0x${"2".repeat(64)}`,
    observedName: "Apple",
    observedSymbol: "AAPLc",
    observedDecimals: 18,
    observedVariant: "asset" as const,
    now: 1_800_000_000,
  };

  it("quarantines once, records a repeat sighting, and never promotes", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(quarantineCandidate, candidate)).resolves.toEqual({ operation: "quarantined" });
    await expect(t.mutation(quarantineCandidate, { ...candidate, now: 1_800_000_500 })).resolves.toEqual({
      operation: "seen_again",
    });

    const stored = await t.run((ctx) => ctx.db.query("stockCandidates").collect());
    expect(stored).toMatchObject([
      { reviewDisposition: "unreviewed", firstSeenAt: 1_800_000_000, lastSeenAt: 1_800_000_500 },
    ]);
    expect(await t.run((ctx) => ctx.db.query("stocks").collect())).toHaveLength(0);
    expect(await t.query(listCandidates, { limit: 10 })).toHaveLength(1);
  });

  it("marks a candidate promoted once the ceremony approves it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(quarantineCandidate, candidate);
    await promote(t);
    expect(await t.run((ctx) => ctx.db.query("stockCandidates").collect())).toMatchObject([
      { reviewDisposition: "promoted" },
    ]);
    expect(await t.query(listCandidates, { limit: 10 })).toHaveLength(0);
  });

  it("skips a candidate whose address is already reviewed", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await expect(t.mutation(quarantineCandidate, candidate)).resolves.toEqual({
      operation: "already_reviewed",
    });
  });

  it("rejects a candidate address that is not checksummed", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(quarantineCandidate, { ...candidate, addressChecksum: APPLE.toLowerCase() }),
    ).rejects.toThrow();
  });
});

describe("monitored stock list", () => {
  it("returns verified and retired stocks for the liability check", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await promote(t, { addressChecksum: AMAZON, symbol: "AMZNc", name: "Amazon", sortOrder: 1 });
    await t.mutation(
      proposeReviewedStock,
      proposal({ addressChecksum: AMAZON, symbol: "AMZNc", name: "Amazon", intent: "retire" }),
    );
    await t.mutation(approveReviewedStock, approval({ addressChecksum: AMAZON, intent: "retire" }));

    const monitored = await t.query(listMonitoredStocks, { chainId: 8453, limit: 50 });
    expect(monitored.map((entry: { symbol: string }) => entry.symbol).sort()).toEqual(
      expect.arrayContaining(["AAPLc", "AMZNc"]),
    );
  });
});

it("monitors Sepolia manifest assets before the catalog has been seeded", async () => {
  const t = convexTest(schema, modules);
  const assets = await t.query(listMonitoredStocks, { chainId: 84532, limit: 50 });
  expect(assets).toHaveLength(13);
});
