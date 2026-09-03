import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const committedPath = resolve(repositoryRoot, "lib/contracts/generated.ts");
const scratchRoot = resolve(repositoryRoot, ".cache");
mkdirSync(scratchRoot, { recursive: true });
const scratchDirectory = mkdtempSync(resolve(scratchRoot, "bindings-check-"));

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

let exitCode = 0;
try {
  const candidatePath = resolve(scratchDirectory, "generated.ts");
  const configPath = resolve(scratchDirectory, "wagmi.config.ts");
  writeFileSync(
    configPath,
    `import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";
import committed from ${JSON.stringify(resolve(repositoryRoot, "wagmi.config.ts"))};

export default defineConfig({ ...committed, out: ${JSON.stringify(candidatePath)} });
`,
  );

  exitCode = run("npx", ["wagmi", "generate", "--config", configPath]);
  if (exitCode === 0) {
    exitCode = run("npx", ["prettier", "--write", "--ignore-path", "/dev/null", candidatePath]);
  }

  if (exitCode === 0) {
    const committedSource = readFileSync(committedPath, "utf8");
    const candidateSource = readFileSync(candidatePath, "utf8");
    if (committedSource === candidateSource) {
      console.log("lib/contracts/generated.ts matches the bindings regenerated from contracts/out");
    } else {
      exitCode = 1;
      console.error("lib/contracts/generated.ts has drifted from the contract artifacts.\n");
      spawnSync(
        "diff",
        ["-u", "--label", "committed", "--label", "regenerated", committedPath, candidatePath],
        { cwd: repositoryRoot, stdio: "inherit" },
      );
      console.error("\nRun `npm run contracts:generate` and review the result.");
    }
  }
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true });
}

process.exit(exitCode);
