import { describe, expect, it, vi } from "vitest";
import { readReceiptWithFallback } from "./secondary";

const hash = `0x${"a".repeat(64)}` as const;

describe("readReceiptWithFallback", () => {
  it("uses the primary reader when it answers", async () => {
    const secondary = { getTransactionReceipt: vi.fn() };
    const primary = { getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }) };

    await expect(readReceiptWithFallback([primary, secondary], hash)).resolves.toEqual({
      status: "success",
    });
    expect(secondary.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("recovers a receipt the primary RPC cannot return", async () => {
    const primary = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("not found")) };
    const secondary = { getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }) };

    await expect(readReceiptWithFallback([primary, secondary], hash)).resolves.toEqual({
      status: "success",
    });
    expect(secondary.getTransactionReceipt).toHaveBeenCalledWith({ hash });
  });

  it("skips absent readers and reports the first failure when none answer", async () => {
    const primary = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("primary down")) };
    const secondary = { getTransactionReceipt: vi.fn().mockRejectedValue(new Error("secondary down")) };

    await expect(readReceiptWithFallback([null, primary, undefined, secondary], hash)).rejects.toThrow(
      "primary down",
    );
  });

  it("fails closed when no reader is configured", async () => {
    await expect(readReceiptWithFallback([null], hash)).rejects.toThrow(
      "No transaction receipt reader is configured",
    );
  });
});
