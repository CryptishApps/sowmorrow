import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const resolve = { tsconfigPaths: true } as const;
const sharedExclude = ["**/node_modules/**", "**/convex/_generated/**", "**/.next/**", "**/contracts/lib/**"];

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "node",
          environment: "node",
          testTimeout: 15_000,
          include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: sharedExclude,
        },
      },
      {
        plugins: [react()],
        resolve,
        test: {
          name: "components",
          environment: "happy-dom",
          testTimeout: 15_000,
          include: ["app/**/*.test.{ts,tsx}", "components/**/*.test.{ts,tsx}"],
          exclude: sharedExclude,
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        resolve,
        test: {
          name: "convex",
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          include: ["convex/**/*.test.ts"],
          exclude: sharedExclude,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "convex/**/*.ts", "lib/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "**/convex/_generated/**",
        "**/convex/schema.ts",
        "**/lib/contracts/generated.ts",
      ],
      thresholds: {
        lines: 85,
        "**/convex/events.ts": { lines: 100, functions: 100 },
        "**/lib/webhooks/cdp.ts": { lines: 100, functions: 100 },
        "**/lib/contracts/receipts.ts": { lines: 100, functions: 100 },
        "**/lib/contracts/manifests.ts": { lines: 100, functions: 100 },
        "**/lib/gifts.ts": { lines: 100, functions: 100 },
      },
    },
  },
});
