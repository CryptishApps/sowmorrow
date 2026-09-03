import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDeploymentManifest } from "../../lib/contracts/manifests";

const files = [
  "contracts/deployments/base-mainnet-8453.json",
  "contracts/deployments/base-sepolia-84532.json",
  "contracts/deployments/local-31337.json",
] as const;
const expectedFileForChain = {
  8453: files[0],
  84532: files[1],
  31337: files[2],
} as const;
const observedChains = new Set<number>();

for (const file of files) {
  const manifest = parseDeploymentManifest(JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")));
  if (expectedFileForChain[manifest.chainId] !== file) {
    throw new Error(`${file}: chain ID does not match its stable manifest path`);
  }
  if (observedChains.has(manifest.chainId)) {
    throw new Error(`${file}: duplicate deployment chain`);
  }
  observedChains.add(manifest.chainId);
  console.log(`validated ${file} (${manifest.status})`);
}
