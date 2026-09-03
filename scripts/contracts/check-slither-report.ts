import { readFileSync } from "node:fs";
import { z } from "zod";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Pass the Slither JSON report path");

const report = z
  .object({
    success: z.boolean(),
    results: z.object({
      detectors: z.array(
        z.object({
          check: z.string(),
          impact: z.string(),
          confidence: z.string(),
          elements: z.array(
            z.object({
              type: z.string(),
              source_mapping: z.object({ filename_relative: z.string() }).passthrough(),
              type_specific_fields: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      ),
    }),
  })
  .parse(JSON.parse(readFileSync(reportPath, "utf8")));

if (!report.success) throw new Error("Slither did not complete successfully");

const expected = new Map([
  ["reentrancy-balance|High|Medium|createGift(address,address,uint256,uint64,bytes32)", 1],
  ["reentrancy-balance|High|Medium|_claim(uint256,address)", 1],
  ["calls-loop|Low|Medium|_validateAsset(address)", 4],
  ["calls-loop|Low|Medium|_claim(uint256,address)", 3],
  ["costly-loop|Informational|Medium|_setSupportedStock(address,bool,uint256)", 1],
  ["timestamp|Low|Medium|createGift(address,address,uint256,uint64,bytes32)", 1],
  ["timestamp|Low|Medium|_claim(uint256,address)", 1],
]);
const actual = new Map<string, number>();

for (const finding of report.results.detectors) {
  const functions = finding.elements.filter((element) => element.type === "function");
  if (functions.length !== 1) throw new Error(`Unexpected Slither finding shape for ${finding.check}`);
  if (
    finding.elements.some((element) => element.source_mapping.filename_relative !== "src/SowmorrowVault.sol")
  ) {
    throw new Error(`Slither finding escaped the reviewed vault source: ${finding.check}`);
  }
  const signature = functions[0].type_specific_fields?.signature;
  if (typeof signature !== "string") throw new Error(`Slither finding has no function signature`);
  const fingerprint = `${finding.check}|${finding.impact}|${finding.confidence}|${signature}`;
  actual.set(fingerprint, (actual.get(fingerprint) ?? 0) + 1);
}

if (
  actual.size !== expected.size ||
  [...expected].some(([fingerprint, count]) => actual.get(fingerprint) !== count)
) {
  throw new Error(`Slither findings differ from the exact reviewed fingerprint set`);
}

console.log(`validated ${report.results.detectors.length} exact triaged Slither findings`);
