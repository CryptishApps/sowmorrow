import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());
const profile = process.argv[2];
if (!["preview", "sepolia", "e2e-enabled", "mainnet"].includes(profile))
  throw new Error("Unknown build profile");
const preview = profile === "preview";
const env = {
  ...process.env,
  NEXT_PUBLIC_SOWMORROW_CHAIN_ID: preview ? "8453" : "84532",
  NEXT_PUBLIC_SOWMORROW_WRITES_ENABLED: preview ? "false" : "true",
  NEXT_PUBLIC_SOWMORROW_MAINNET_RELEASED: "false",
};
if (profile !== "sepolia" && profile !== "mainnet") env.NEXT_PUBLIC_CONVEX_URL = "";
if (profile === "mainnet") {
  Object.assign(
    env,
    JSON.parse(readFileSync(new URL("../data/mainnet-public-environment.json", import.meta.url), "utf8")),
  );
}
if (profile === "e2e-enabled") {
  env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:3217/test-rpc";
  env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL_SECONDARY = "";
}
if (profile === "sepolia" && !env.NEXT_PUBLIC_CONVEX_URL)
  throw new Error("Sepolia release requires NEXT_PUBLIC_CONVEX_URL");
const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
