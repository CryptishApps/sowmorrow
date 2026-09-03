import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { mirrorApi, mirrorConfigured } from "./api";

describe("mirror function references", () => {
  it("points at the exact Convex functions the backend exposes", () => {
    expect(
      Object.fromEntries(
        Object.entries(mirrorApi).map(([key, reference]) => [key, getFunctionName(reference)]),
      ),
    ).toEqual({
      giftsForRecipient: "gifts:forRecipient",
      giftDetail: "gifts:detail",
      freshness: "gifts:freshness",
      noteForGift: "notes:noteForGift",
      attachNote: "notes:attachNote",
    });
  });

  it("treats an unset NEXT_PUBLIC_CONVEX_URL as chain-only rather than a failure", () => {
    expect(mirrorConfigured).toBe(false);
  });
});
