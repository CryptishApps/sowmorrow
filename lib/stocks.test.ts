import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { b20, stocks } from "@/lib/stocks";

describe("official Coinbase stock catalog", () => {
  it("contains the complete 13-stock launch catalog in display order", () => {
    expect(stocks.map(({ symbol }) => symbol)).toEqual([
      "AAPLc",
      "AMZNc",
      "COINc",
      "CRCLc",
      "GOOGLc",
      "INTCc",
      "METAc",
      "MSFTc",
      "MSTRc",
      "NVDAc",
      "SNDKc",
      "SPCXc",
      "TSLAc",
    ]);
  });
});

describe("reviewed B20 catalog metadata", () => {
  it("exposes the parsed Beryl factory so other modules never reparse the catalog JSON", () => {
    expect(b20).toEqual({
      generation: "beryl",
      factoryAddress: getAddress(b20.factoryAddress),
      variant: "asset",
      wadPrecision: "1000000000000000000",
    });
  });
});
