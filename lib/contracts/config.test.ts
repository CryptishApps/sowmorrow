import mainnetJson from "../../contracts/deployments/base-mainnet-8453.json";
import { describe, expect, it } from "vitest";
import { base, baseSepolia } from "viem/chains";
import { stocks } from "@/lib/stocks";
import type { DeploymentManifest, DeploymentRegistry } from "./manifests";
import { parseAppDeployment } from "./config";

const vault = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const runtimeBytecodeHash = `0x${"3".repeat(64)}` as const;

function activeManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    contractVersion: "1.0.0",
    chainId: 8453,
    network: "base-mainnet",
    status: "active",
    vaultAddress: vault,
    deploymentBlock: 123_456,
    runtimeBytecodeHash,
    owner: { kind: "safe", address: owner },
    startPaused: true,
    expectedCreationPaused: false,
    catalogAddressSetSha256: "6f9668465af1f0f939d7c9e9c46fc0ad00eecd02782f1983a9f67bce87f7b92f",
    stocks: stocks.map((stock) => ({ symbol: stock.symbol, address: stock.mainnetAddress })),
    ...overrides,
  };
}

function registry(manifest: DeploymentManifest): DeploymentRegistry {
  return { [manifest.chainId]: manifest };
}

describe("manifest-backed public deployment configuration", () => {
  it("defaults to the checked, read-only Base catalog", () => {
    const deployment = parseAppDeployment({});
    expect(deployment.chainId).toBe(base.id);
    expect(deployment.writesEnabled).toBe(false);
    expect(deployment.vaultAddress).toBe(mainnetJson.vaultAddress);
    expect(deployment.deploymentBlock).toBe(mainnetJson.deploymentBlock);
    expect(Object.keys(deployment.stockAddresses)).toHaveLength(13);
  });

  it("cannot enable writes while the checked manifest is pending", () => {
    expect(() =>
      parseAppDeployment(
        {
          NEXT_PUBLIC_SOWMORROW_CHAIN_ID: String(base.id),
          NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "true",
          NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED: "true",
        },
        registry(
          activeManifest({
            status: "pending",
            vaultAddress: null,
            deploymentBlock: null,
            runtimeBytecodeHash: null,
            owner: { kind: "smart-wallet", address: null },
            expectedCreationPaused: null,
          }),
        ),
      ),
    ).toThrow(/active manifest/i);
  });

  it("requires the explicit release gate for an active mainnet manifest", () => {
    const manifests = registry(activeManifest());
    expect(() =>
      parseAppDeployment(
        {
          NEXT_PUBLIC_SOWMORROW_CHAIN_ID: String(base.id),
          NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "true",
        },
        manifests,
      ),
    ).toThrow(/mainnet release gate/i);

    const deployment = parseAppDeployment(
      {
        NEXT_PUBLIC_SOWMORROW_CHAIN_ID: String(base.id),
        NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "true",
        NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED: "true",
      },
      manifests,
    );
    expect(deployment.writesEnabled).toBe(true);
    expect(deployment.vaultAddress).toBe(vault);
    expect(deployment.deploymentBlock).toBe(123_456);
  });

  it("uses only fixture addresses recorded in an active Sepolia manifest", () => {
    const manifest = activeManifest({
      chainId: 84532,
      network: "base-sepolia",
      owner: { kind: "test-safe", address: owner },
      startPaused: false,
      catalogAddressSetSha256: null,
      stocks: [{ symbol: "AAPLc", address: owner }],
    });
    const deployment = parseAppDeployment(
      {
        NEXT_PUBLIC_SOWMORROW_CHAIN_ID: String(baseSepolia.id),
        NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "true",
      },
      registry(manifest),
    );
    expect(deployment.stockAddresses).toEqual({ AAPLc: owner });
  });

  it("allows claims from a retired manifest but never enables new writes", () => {
    const manifest = activeManifest({ status: "retired" });
    const readDeployment = parseAppDeployment({}, registry(manifest));
    expect(readDeployment.vaultAddress).toBe(vault);
    expect(readDeployment.writesEnabled).toBe(false);
    expect(() =>
      parseAppDeployment(
        {
          NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "true",
          NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED: "true",
        },
        registry(manifest),
      ),
    ).toThrow(/active manifest/i);
  });

  it("rejects unsupported chains and malformed Boolean gates", () => {
    expect(() => parseAppDeployment({ NEXT_PUBLIC_SOWMORROW_CHAIN_ID: "1" })).toThrow(/chain/i);
    expect(() => parseAppDeployment({ NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: "yes" })).toThrow(
      /true or false/i,
    );
  });
});
