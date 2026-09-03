import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { giftRoutePath, parseGiftRoute } from "./gift-link";
import type { DeploymentRegistry } from "./manifests";

const activeVault = getAddress("0x1111111111111111111111111111111111111111");
const otherVault = getAddress("0x2222222222222222222222222222222222222222");
const stock = getAddress("0x3333333333333333333333333333333333333333");

const registry = {
  8453: {
    schemaVersion: 1,
    contractVersion: "1.0.0",
    chainId: 8453,
    network: "base-mainnet",
    status: "pending",
    vaultAddress: null,
    deploymentBlock: null,
    runtimeBytecodeHash: null,
    owner: { kind: "safe", address: null },
    startPaused: true,
    expectedCreationPaused: null,
    catalogAddressSetSha256: null,
    stocks: [],
  },
  84532: {
    schemaVersion: 1,
    contractVersion: "1.0.0",
    chainId: 84532,
    network: "base-sepolia",
    status: "active",
    vaultAddress: activeVault,
    deploymentBlock: 10,
    runtimeBytecodeHash: `0x${"a".repeat(64)}`,
    owner: { kind: "test-safe", address: activeVault },
    startPaused: false,
    expectedCreationPaused: false,
    catalogAddressSetSha256: null,
    stocks: [{ symbol: "AAPLc", address: stock }],
  },
} as unknown as DeploymentRegistry;

describe("parseGiftRoute", () => {
  it("accepts the manifest vault of an active chain", () => {
    expect(parseGiftRoute({ chainId: "84532", vault: activeVault, giftId: "7" }, registry)).toMatchObject({
      chainId: 84532,
      vault: activeVault,
      giftId: "7",
      manifestStatus: "active",
      vaultIsManifestVault: true,
      networkName: "Base Sepolia",
    });
  });

  it("checksums a lowercase vault from the URL", () => {
    expect(
      parseGiftRoute({ chainId: "84532", vault: activeVault.toLowerCase(), giftId: "7" }, registry)?.vault,
    ).toBe(activeVault);
  });

  it("rejects a vault that is not the active manifest vault", () => {
    expect(parseGiftRoute({ chainId: "84532", vault: otherVault, giftId: "7" }, registry)).toBeNull();
  });

  it("accepts any well-formed vault while the manifest is still pending", () => {
    expect(parseGiftRoute({ chainId: "8453", vault: otherVault, giftId: "7" }, registry)).toMatchObject({
      manifestStatus: "pending",
      vaultIsManifestVault: false,
    });
  });

  it.each([
    { chainId: "1", vault: activeVault, giftId: "7" },
    { chainId: "84532", vault: "0xnope", giftId: "7" },
    { chainId: "84532", vault: activeVault, giftId: "0" },
    { chainId: "84532", vault: activeVault, giftId: "07" },
    { chainId: "84532", vault: activeVault, giftId: "-1" },
    { chainId: "84532", vault: activeVault, giftId: "1e3" },
    { chainId: "084532", vault: activeVault, giftId: "1" },
  ])("rejects invalid params %o", (params) => {
    expect(parseGiftRoute(params, registry)).toBeNull();
  });
});

describe("giftRoutePath", () => {
  it("builds the canonical chain, vault, and gift id link", () => {
    expect(giftRoutePath(84532, activeVault, 7n)).toBe(`/gift/84532/${activeVault}/7`);
  });
});
