import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { stockSymbols } from "../../lib/stocks";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("manifest-from-broadcast", () => {
  it("writes an active Base Sepolia fixture manifest from matching deployment evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "sowmorrow-sepolia-manifest-"));
    temporaryDirectories.push(directory);
    const artifactPath = resolve(directory, "artifact.json");
    const broadcastPath = resolve(directory, "broadcast.json");
    const outputPath = resolve(directory, "manifest.json");
    const deployer = "0x44eAe526868aC7ce0499a6642440Eba9a61cC1e0";
    const owner = "0x2222222222222222222222222222222222222222";
    const vaultAddress = "0x1111111111111111111111111111111111111111";
    const transactionHash = `0x${"12".repeat(32)}`;
    const fixtureAddresses = stockSymbols.map(
      (_, index) => `0x${(index + 100).toString(16).padStart(40, "0")}`,
    );

    writeFileSync(
      artifactPath,
      JSON.stringify({
        chainId: 84532,
        contractVersion: "1.0.0",
        simulationBlock: 100,
        deployer,
        owner,
        vaultAddress,
        faucetAddress: "0x3333333333333333333333333333333333333333",
        runtimeBytecodeHash: `0x${"ab".repeat(32)}`,
        startPaused: false,
        fixtureNames: stockSymbols.map((_, index) => `Sowmorrow Test Stock ${index + 1}`),
        fixtureSymbols: stockSymbols.map((_, index) => `SMT${index + 1}`),
        fixtureAddresses,
      }),
    );
    writeFileSync(
      broadcastPath,
      JSON.stringify({
        chain: 84532,
        transactions: [
          {
            hash: transactionHash,
            transactionType: "CREATE",
            contractName: "SowmorrowVault",
            contractAddress: vaultAddress,
          },
        ],
        receipts: [{ transactionHash, blockNumber: "0x7b" }],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/contracts/manifest-from-broadcast.ts"),
        "--chain-id",
        "84532",
        "--artifact",
        artifactPath,
        "--broadcast",
        broadcastPath,
        "--out",
        outputPath,
      ],
      { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      chainId: 84532,
      network: "base-sepolia",
      status: "active",
      vaultAddress,
      deploymentBlock: 123,
      owner: { kind: "test-eoa", address: owner },
      stocks: stockSymbols.map((symbol, index) => ({ symbol, address: getAddress(fixtureAddresses[index]) })),
    });
  });
});
