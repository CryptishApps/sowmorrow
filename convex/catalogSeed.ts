import { internalMutation } from "./_generated/server";
import { stockCatalogEvidence, stocks } from "../lib/stocks";

export const seedReviewedMainnet = internalMutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0;
    let updated = 0;
    const reviewedAt = Math.floor(new Date(stockCatalogEvidence.retrievedAt).getTime() / 1_000);

    for (const [sortOrder, stock] of stocks.entries()) {
      const addressLower = stock.mainnetAddress.toLowerCase();
      const record = {
        chainId: 8453,
        addressLower,
        addressChecksum: stock.mainnetAddress,
        symbol: stock.symbol,
        name: stock.name,
        decimals: stock.decimals,
        reviewStatus: "verified" as const,
        reviewedSourceUrl: stockCatalogEvidence.url,
        reviewedSourceHash: `sha256:${stockCatalogEvidence.contentSha256}`,
        reviewedAt,
        b20Generation: "beryl" as const,
        sortOrder,
        vaultSupported: "unknown" as const,
      };
      const existing = await ctx.db
        .query("stocks")
        .withIndex("by_chain_address", (queryBuilder) =>
          queryBuilder.eq("chainId", 8453).eq("addressLower", addressLower),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, record);
        updated += 1;
      } else {
        await ctx.db.insert("stocks", record);
        inserted += 1;
      }
    }

    return { inserted, updated };
  },
});
