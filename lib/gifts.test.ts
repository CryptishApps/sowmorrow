import { describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToBytes, toCoinType, zeroAddress, zeroHash } from "viem";
import { identityNetwork } from "./web3/identity";
import {
  formatUnlockReview,
  hashGiftNote,
  isGiftNoteValid,
  minimumUnlockDate,
  noteByteLength,
  parseGiftAmount,
  resolveRecipient,
  toUnlockAt,
} from "./gifts";

describe("gift input boundaries", () => {
  it("parses positive decimal amounts into exact raw units", () => {
    expect(parseGiftAmount("0.25", 18)).toBe(250_000_000_000_000_000n);
    expect(parseGiftAmount("1", 6)).toBe(1_000_000n);
  });

  it.each(["", "0", "-1", "one", "1.0000001"])("rejects an invalid six-decimal amount: %s", (input) => {
    expect(parseGiftAmount(input, 6)).toBeNull();
  });

  it("rejects excess precision even when viem would round it to a valid value", () => {
    expect(parseGiftAmount("1.23001", 2)).toBeNull();
    expect(parseGiftAmount("1.22999", 2)).toBeNull();
    expect(parseGiftAmount("1.2300", 2)).toBe(123n);
  });

  it("creates deterministic UTC unlock timestamps and minimum dates", () => {
    const unlockAt = toUnlockAt("2030-03-12");
    expect(unlockAt).not.toBeNull();
    const local = new Date(Number(unlockAt) * 1_000);
    expect([local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours()]).toEqual([
      2030, 3, 12, 9,
    ]);
    expect(toUnlockAt("not-a-date")).toBeNull();
    expect(toUnlockAt("1960-01-01")).toBeNull();
    expect(toUnlockAt("2030-02-30")).toBeNull();
    const now = new Date(2030, 2, 11, 23, 59).getTime();
    expect(minimumUnlockDate(now)).toBe("2030-03-12");
    expect(formatUnlockReview(unlockAt!)).toMatchObject({
      localDate: expect.stringContaining("2030"),
      utc: new Date(Number(unlockAt) * 1_000).toISOString(),
    });
  });

  it("hashes the exact reviewed note bytes and enforces the UTF-8 byte cap", () => {
    expect(hashGiftNote("")).toBe(zeroHash);
    expect(hashGiftNote("   ")).not.toBe(zeroHash);
    expect(hashGiftNote("For your first home")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashGiftNote("For your first home")).toBe(hashGiftNote("For your first home"));
    expect(hashGiftNote("0xdeadbeef")).toBe(keccak256(stringToBytes("0xdeadbeef")));
    expect(hashGiftNote("0x")).toBe(keccak256(stringToBytes("0x")));
    expect(hashGiftNote("é")).not.toBe(hashGiftNote("é"));
    expect(noteByteLength("🌱")).toBe(4);
    expect(isGiftNoteValid("a".repeat(280))).toBe(true);
    expect(isGiftNoteValid("🌱".repeat(71))).toBe(false);
    expect(() => hashGiftNote("a".repeat(281))).toThrow(RangeError);
  });
});

describe("recipient resolution", () => {
  it("honors a Basename's chain-specific address before its default address", async () => {
    const preferred = "0x2222222222222222222222222222222222222222";
    const readContract = vi
      .fn()
      .mockImplementation(async ({ functionName, args }) =>
        functionName === "resolver"
          ? "0x3333333333333333333333333333333333333333"
          : args.length === 2
            ? preferred
            : "0x4444444444444444444444444444444444444444",
      );
    await expect(
      resolveRecipient("alice.base.eth", { getEnsAddress: vi.fn() }, { chainId: 8453, readContract }),
    ).resolves.toBe(preferred);
  });
  it.each([8453, 84532, 31337] as const)(
    "uses the configured identity registry on chain %s",
    async (chainId) => {
      const recipient = getAddress("0x2222222222222222222222222222222222222222");
      const resolver = getAddress("0x3333333333333333333333333333333333333333");
      const readContract = vi
        .fn()
        .mockResolvedValueOnce(resolver)
        .mockResolvedValueOnce("0x")
        .mockResolvedValueOnce(recipient);
      const getEnsAddress = vi.fn().mockResolvedValue(null);
      await expect(
        resolveRecipient("alice.base.eth", { getEnsAddress }, { chainId, readContract }),
      ).resolves.toBe(recipient);
      expect(readContract.mock.calls[0][0].address).toBe(
        chainId === 8453
          ? "0xb94704422c2a1e396835a571837aa5ae53285a95"
          : "0x1493b2567056c2181630115660963E13A8E32735",
      );
      expect(getEnsAddress).not.toHaveBeenCalled();
      expect(identityNetwork(chainId)).toMatchObject({
        baseChainId: chainId === 8453 ? 8453 : 84532,
        ensChainId: chainId === 8453 ? 1 : 11155111,
      });
    },
  );

  it("uses testnet ENS records when a name is absent from the testnet Base registry", async () => {
    const recipient = getAddress("0x2222222222222222222222222222222222222222");
    const readContract = vi.fn().mockResolvedValue(zeroAddress);
    const getEnsAddress = vi.fn().mockResolvedValue(recipient);
    await expect(
      resolveRecipient("alice.eth", { getEnsAddress }, { chainId: 84532, readContract }),
    ).resolves.toBe(recipient);
    expect(getEnsAddress).toHaveBeenCalledWith({ name: "alice.eth", coinType: toCoinType(84532) });
  });

  it("does not fall back to another identity when a registered Basename has no address", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce("0x3333333333333333333333333333333333333333")
      .mockResolvedValueOnce(zeroAddress);
    const getEnsAddress = vi.fn().mockResolvedValue("0x2222222222222222222222222222222222222222");
    await expect(
      resolveRecipient("alice.base.eth", { getEnsAddress }, { chainId: 8453, readContract }),
    ).resolves.toBeNull();
    expect(getEnsAddress).not.toHaveBeenCalled();
  });

  it("checksums a direct address without making a resolver request", async () => {
    const getEnsAddress = vi.fn();
    const readContract = vi.fn();
    const input = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

    await expect(resolveRecipient(input, { getEnsAddress }, { chainId: 84532, readContract })).resolves.toBe(
      getAddress(input),
    );
    expect(getEnsAddress).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it("normalizes a name and requests its Base-specific address", async () => {
    const resolved = getAddress("0x2B0F09F23193de2Fb66258a10886B9f06903276c");
    const getEnsAddress = vi.fn().mockResolvedValue(resolved);

    await expect(resolveRecipient("TEST.SES.ETH", { getEnsAddress })).resolves.toBe(resolved);
    expect(getEnsAddress).toHaveBeenCalledOnce();
    expect(getEnsAddress.mock.calls[0]?.[0]).toMatchObject({ name: "test.ses.eth" });
    expect(getEnsAddress.mock.calls[0]?.[0].coinType).toBeTypeOf("bigint");
  });

  it("returns null when a valid name has no Base address", async () => {
    const getEnsAddress = vi.fn().mockResolvedValue(null);
    await expect(resolveRecipient("nobody.base.eth", { getEnsAddress })).resolves.toBeNull();
  });
});
