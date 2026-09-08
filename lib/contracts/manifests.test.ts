import { describe, expect, it } from "vitest";
import mainnetJson from "../../contracts/deployments/base-mainnet-8453.json";
import sepoliaJson from "../../contracts/deployments/base-sepolia-84532.json";
import localJson from "../../contracts/deployments/local-31337.json";
import { stockCatalogEvidence, stocks } from "../stocks";
import {
  activeManifestForChain,
  activeManifestFromEnvironment,
  manifestForChain,
  manifestStockAddresses,
  parseDeploymentManifest,
} from "./manifests";
import type { DeploymentManifest, DeploymentRegistry } from "./manifests";

const vault = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const runtimeBytecodeHash = `0x${"ab".repeat(32)}`;

function pendingMainnet() {
  return parseDeploymentManifest({
    ...mainnetJson,
    status: "pending",
    vaultAddress: null,
    deploymentBlock: null,
    runtimeBytecodeHash: null,
    owner: { kind: "smart-wallet", address: null },
    expectedCreationPaused: null,
  });
}

function activeMainnet(): DeploymentManifest {
  return parseDeploymentManifest({
    ...mainnetJson,
    status: "active",
    vaultAddress: vault,
    deploymentBlock: 100,
    runtimeBytecodeHash,
    owner: { kind: "safe", address: owner },
    expectedCreationPaused: true,
    catalogAddressSetSha256: stockCatalogEvidence.addressSetSha256,
    stocks: stocks.map((stock) => ({ symbol: stock.symbol, address: stock.mainnetAddress })),
  });
}

function pendingSepolia() {
  return {
    ...sepoliaJson,
    status: "pending",
    vaultAddress: null,
    deploymentBlock: null,
    runtimeBytecodeHash: null,
    expectedCreationPaused: null,
    stocks: [],
  } as const;
}

describe("deployment manifest parsing", () => {
  it("accepts the three checked manifests", () => {
    expect(parseDeploymentManifest(mainnetJson).chainId).toBe(8453);
    expect(parseDeploymentManifest(sepoliaJson).chainId).toBe(84532);
    expect(parseDeploymentManifest(localJson).chainId).toBe(31337);
  });

  it("rejects a chain and network that disagree", () => {
    expect(() => parseDeploymentManifest({ ...mainnetJson, network: "base-sepolia" })).toThrow(
      "chain and network disagree",
    );
  });

  it("requires every deployment field once a manifest is no longer pending", () => {
    expect(() => parseDeploymentManifest({ ...pendingMainnet(), status: "active" })).toThrow(
      "requires a vault, block, runtime hash, and owner",
    );
  });

  it("rejects duplicate stock symbols or addresses", () => {
    const apple = stocks[0];
    expect(() =>
      parseDeploymentManifest({
        ...localJson,
        stocks: [
          { symbol: apple.symbol, address: apple.mainnetAddress },
          { symbol: apple.symbol, address: apple.mainnetAddress },
        ],
      }),
    ).toThrow("must be unique");
  });

  it("accepts an explicitly recorded smart-wallet owner on mainnet", () => {
    expect(
      parseDeploymentManifest({ ...activeMainnet(), owner: { kind: "smart-wallet", address: owner } }).owner
        .kind,
    ).toBe("smart-wallet");
  });

  it("requires a Safe or smart-wallet owner and paused launch on Base mainnet", () => {
    expect(() =>
      parseDeploymentManifest({ ...pendingMainnet(), owner: { kind: "test-safe", address: null } }),
    ).toThrow("Safe or smart-wallet owner and paused launch");
    expect(() => parseDeploymentManifest({ ...mainnetJson, startPaused: false })).toThrow(
      "Safe or smart-wallet owner and paused launch",
    );
  });

  it("rejects stale mainnet catalog evidence and a stock list that differs from the catalog", () => {
    expect(() =>
      parseDeploymentManifest({ ...mainnetJson, catalogAddressSetSha256: "0".repeat(64) }),
    ).toThrow("catalog evidence is stale");
    expect(() =>
      parseDeploymentManifest({
        ...mainnetJson,
        stocks: [{ symbol: stocks[0].symbol, address: stocks[0].mainnetAddress }],
      }),
    ).toThrow("differs from the reviewed stock catalog");
    expect(() =>
      parseDeploymentManifest({
        ...mainnetJson,
        stocks: stocks.map((stock, index) => ({
          symbol: stock.symbol,
          address: index === 0 ? vault : stock.mainnetAddress,
        })),
      }),
    ).toThrow("differs from the reviewed stock catalog");
  });

  it("accepts explicit test owners on Sepolia and requires a local EOA locally", () => {
    expect(
      parseDeploymentManifest({ ...pendingSepolia(), owner: { kind: "test-eoa", address: null } }).owner.kind,
    ).toBe("test-eoa");
    expect(() =>
      parseDeploymentManifest({ ...pendingSepolia(), owner: { kind: "safe", address: null } }),
    ).toThrow("test owner");
    expect(() => parseDeploymentManifest({ ...localJson, owner: { kind: "safe", address: null } })).toThrow(
      "local EOA owner",
    );
  });

  it("requires at least one stock on an active deployment", () => {
    expect(() =>
      parseDeploymentManifest({
        ...localJson,
        status: "active",
        vaultAddress: vault,
        deploymentBlock: 1,
        runtimeBytecodeHash,
        owner: { kind: "local-eoa", address: owner },
        expectedCreationPaused: false,
        stocks: [],
      }),
    ).toThrow("at least one supported stock");
  });
});

describe("manifest lookup", () => {
  it("fails closed when a chain has no checked manifest", () => {
    const registry: DeploymentRegistry = {};
    expect(() => manifestForChain(8453, registry)).toThrow("No checked deployment manifest");
    expect(() => activeManifestForChain(8453, registry)).toThrow("No checked deployment manifest");
  });

  it("refuses a pending manifest as active and narrows an active one", () => {
    expect(() => activeManifestForChain(8453, { 8453: pendingMainnet() })).toThrow(
      "no active checked deployment manifest",
    );
    const active = activeManifestForChain(8453, { 8453: activeMainnet() });
    expect(active.vaultAddress).toBe(vault);
    expect(active.owner.address).toBe(owner);
    expect(active.status).toBe("active");
  });

  it("reads the deployment chain from the environment and rejects other chains", () => {
    expect(() => activeManifestFromEnvironment({})).toThrow("must select Base mainnet or Base Sepolia");
    expect(() => activeManifestFromEnvironment({ SOWMORROW_DEPLOYMENT_CHAIN_ID: "31337" })).toThrow(
      "must select Base mainnet or Base Sepolia",
    );
    expect(activeManifestFromEnvironment({ SOWMORROW_DEPLOYMENT_CHAIN_ID: "8453" }).vaultAddress).toBe(
      mainnetJson.vaultAddress,
    );
  });

  it("maps manifest stocks to addresses by symbol", () => {
    const addresses = manifestStockAddresses(activeMainnet());
    expect(addresses[stocks[0].symbol]).toBe(stocks[0].mainnetAddress);
    expect(Object.keys(addresses)).toHaveLength(stocks.length);
    expect(manifestStockAddresses(parseDeploymentManifest(localJson))).toEqual({});
  });
});
