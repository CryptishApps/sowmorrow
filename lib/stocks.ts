import { getAddress, isAddress } from "viem";
import type { Address } from "viem";
import { z } from "zod";
import catalogJson from "../data/reviewed-stock-catalog.base-mainnet.json";

export const stockSymbols = [
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
] as const;

export type StockSymbol = (typeof stockSymbols)[number];

export type Stock = {
  symbol: StockSymbol;
  officialName: string;
  name: string;
  hue: number;
  decimals: number;
  mainnetAddress: Address;
};

const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "Invalid EVM address")
  .transform((value) => getAddress(value));

const sha256Schema = z.string().length(64);
const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainId: z.literal(8453),
    network: z.literal("base-mainnet"),
    reviewedSource: z
      .object({
        url: z.literal("https://docs.base.org/specifications/b20/tokenized-stocks-on-base"),
        retrievedAt: z.string().min(1),
        contentSha256: sha256Schema,
        addressSetSha256: sha256Schema,
        rpcVerifiedAtBlock: z.number().int().nonnegative().safe(),
      })
      .strict(),
    b20: z
      .object({
        generation: z.literal("beryl"),
        factoryAddress: addressSchema,
        variant: z.literal("asset"),
        wadPrecision: z.literal("1000000000000000000"),
      })
      .strict(),
    stocks: z
      .array(
        z
          .object({
            symbol: z.enum(stockSymbols),
            officialName: z.string().min(1),
            displayName: z.string().min(1),
            address: addressSchema,
            decimals: z.number().int().min(0).max(255),
            hue: z.number().int().min(0).max(359),
          })
          .strict(),
      )
      .length(stockSymbols.length),
  })
  .strict();

const catalog = catalogSchema.parse(catalogJson);

export const stockCatalogEvidence = catalog.reviewedSource;

export type B20Catalog = {
  generation: "beryl";
  factoryAddress: Address;
  variant: "asset";
  wadPrecision: "1000000000000000000";
};

export const b20: B20Catalog = catalog.b20;

export const stocks: readonly Stock[] = catalog.stocks.map((stock) => ({
  symbol: stock.symbol,
  officialName: stock.officialName,
  name: stock.displayName,
  hue: stock.hue,
  decimals: stock.decimals,
  mainnetAddress: stock.address,
}));
