import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { executeClaim, executePlant, executePreparedPlant, GiftFlowError, preparePlant } from "./flows";

const account = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");
const stock = getAddress("0x3333333333333333333333333333333333333333");
const vault = getAddress("0x4444444444444444444444444444444444444444");
const approvalHash = `0x${"a".repeat(64)}` as const;
const giftHash = `0x${"b".repeat(64)}` as const;

function plantGateway(overrides: Record<string, unknown> = {}) {
  return {
    resolveRecipient: vi.fn().mockResolvedValue(recipient),
    getBlockSnapshot: vi.fn().mockResolvedValue({ number: 123n, timestamp: 1_900_000_000n }),
    getVaultVersion: vi.fn().mockResolvedValue("1.0.0"),
    getDecimals: vi.fn().mockResolvedValue(6),
    toRawBalance: vi.fn().mockResolvedValue(250_000n),
    toScaledBalance: vi.fn().mockResolvedValue(250_000n),
    getRawBalance: vi.fn().mockResolvedValue(1_000_000n),
    getAllowance: vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(0n).mockResolvedValue(250_000n),
    isStockSupported: vi.fn().mockResolvedValue(true),
    getMinGiftAmountRaw: vi.fn().mockResolvedValue(1n),
    isCreationPaused: vi.fn().mockResolvedValue(false),
    hasContractCode: vi.fn().mockResolvedValue(false),
    approve: vi.fn().mockResolvedValue(approvalHash),
    createGift: vi.fn().mockResolvedValue(giftHash),
    waitForApprovalReceipt: vi.fn().mockResolvedValue(undefined),
    waitForGiftReceipt: vi.fn().mockResolvedValue({ giftId: 7n }),
    ...overrides,
  };
}

describe("executePlant", () => {
  it("performs exact approval then gift creation with observable phases", async () => {
    const gateway = plantGateway();
    const phases: string[] = [];

    const result = await executePlant(
      gateway,
      {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      },
      (phase) => phases.push(phase),
    );

    expect(gateway.approve).toHaveBeenCalledWith(stock, vault, 250_000n);
    expect(gateway.createGift).toHaveBeenCalledWith(
      stock,
      recipient,
      250_000n,
      2_000_000_000n,
      `0x${"0".repeat(64)}`,
    );
    expect(gateway.waitForGiftReceipt).toHaveBeenCalledWith(giftHash, {
      vault,
      sender: account,
      recipient,
      stock,
      amountRaw: 250_000n,
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    expect(result).toMatchObject({ recipient, amountRaw: 250_000n, approvalHash, giftHash, giftId: 7n });
    expect(phases).toEqual([
      "resolving_recipient",
      "quoting_amount",
      "revalidating_review",
      "awaiting_approval",
      "confirming_approval",
      "awaiting_plant",
      "confirming_plant",
      "success",
    ]);
  });

  it("skips approval when the existing allowance is sufficient", async () => {
    const gateway = plantGateway({ getAllowance: vi.fn().mockResolvedValue(250_000n) });
    const result = await executePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: recipient,
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(result.approvalHash).toBeNull();
  });

  it("rounds raw units up when the B20 multiplier would underfund the displayed amount", async () => {
    const gateway = plantGateway({
      toRawBalance: vi.fn().mockResolvedValue(249_999n),
      toScaledBalance: vi
        .fn()
        .mockResolvedValueOnce(249_999n)
        .mockResolvedValueOnce(250_001n)
        .mockResolvedValue(250_001n),
    });
    await executePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: recipient,
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    expect(gateway.createGift).toHaveBeenCalledWith(
      stock,
      recipient,
      250_000n,
      2_000_000_000n,
      `0x${"0".repeat(64)}`,
    );
  });

  it("prepares a complete immutable review intent without prompting the wallet", async () => {
    const gateway = plantGateway();
    const intent = await preparePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: "recipient.base.eth",
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"1".repeat(64)}`,
    });

    expect(intent).toMatchObject({
      account,
      stock,
      vault,
      recipient,
      recipientInput: "recipient.base.eth",
      amountInput: "0.25",
      amountScaled: 250_000n,
      amountRaw: 250_000n,
      transferableAmountScaled: 250_000n,
      approvalRequired: true,
      observedBlockNumber: 123n,
      observedBlockTimestamp: 1_900_000_000n,
      vaultVersion: "1.0.0",
    });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("reports the gift hash before receipt waiting so an uncertain submission remains recoverable", async () => {
    const gateway = plantGateway({
      getAllowance: vi.fn().mockResolvedValue(250_000n),
      waitForGiftReceipt: vi.fn().mockRejectedValue(new Error("rpc timeout")),
    });
    const intent = await preparePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: recipient,
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    const submitted: Array<{ kind: string; hash: string }> = [];

    await expect(
      executePreparedPlant(gateway, intent, undefined, (transaction) => submitted.push(transaction)),
    ).rejects.toThrow("rpc timeout");
    expect(submitted).toEqual([{ kind: "gift", hash: giftHash }]);
    expect(gateway.resolveRecipient).toHaveBeenCalledTimes(3);
  });

  it("invalidates the review if the recipient name resolves differently before signing", async () => {
    const changedRecipient = getAddress("0x5555555555555555555555555555555555555555");
    const gateway = plantGateway({
      resolveRecipient: vi.fn().mockResolvedValueOnce(recipient).mockResolvedValueOnce(changedRecipient),
    });
    const intent = await preparePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: "recipient.base.eth",
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });

    await expect(executePreparedPlant(gateway, intent)).rejects.toMatchObject({ code: "review_changed" });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("rejects an unlock instant inside the Base block-time safety margin", async () => {
    await expect(
      preparePlant(plantGateway(), {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 1_900_000_300n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "unlock_too_soon" });
  });

  it("rejects an amount below the vault's minimum with the minimum named in shares", async () => {
    const gateway = plantGateway({ getMinGiftAmountRaw: vi.fn().mockResolvedValue(300_000n) });
    await expect(
      executePlant(gateway, {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      code: "amount_below_minimum",
      message: expect.stringContaining("0.25 shares"),
    });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("allows an amount exactly at the vault's minimum", async () => {
    const gateway = plantGateway({ getMinGiftAmountRaw: vi.fn().mockResolvedValue(250_000n) });
    const intent = await preparePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: recipient,
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    expect(intent.amountRaw).toBe(250_000n);
    expect(intent.minAmountRaw).toBe(250_000n);
  });

  it("invalidates the review when the minimum rises above the reviewed amount before signing", async () => {
    const gateway = plantGateway({
      getMinGiftAmountRaw: vi.fn().mockResolvedValueOnce(1n).mockResolvedValue(300_000n),
    });
    const intent = await preparePlant(gateway, {
      account,
      stock,
      vault,
      recipientInput: recipient,
      amountInput: "0.25",
      unlockAt: 2_000_000_000n,
      noteHash: `0x${"0".repeat(64)}`,
    });
    await expect(executePreparedPlant(gateway, intent)).rejects.toMatchObject({ code: "review_changed" });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("stops before wallet prompts when balance is insufficient", async () => {
    const gateway = plantGateway({ getRawBalance: vi.fn().mockResolvedValue(10n) });
    await expect(
      executePlant(gateway, {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it.each([
    ["stock_unavailable", { isStockSupported: vi.fn().mockResolvedValue(false) }],
    ["creation_paused", { isCreationPaused: vi.fn().mockResolvedValue(true) }],
  ])("stops before approval when the vault reports %s", async (code, overrides) => {
    const gateway = plantGateway(overrides);
    await expect(
      executePlant(gateway, {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code });
    expect(gateway.approve).not.toHaveBeenCalled();
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("does not create a gift when the confirmed approval remains insufficient", async () => {
    const gateway = plantGateway({ getAllowance: vi.fn().mockResolvedValue(0n) });
    await expect(
      executePlant(gateway, {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "approval_not_confirmed" });
    expect(gateway.createGift).not.toHaveBeenCalled();
  });

  it("rejects unresolved recipients and malformed amounts with typed errors", async () => {
    const unresolved = plantGateway({ resolveRecipient: vi.fn().mockResolvedValue(null) });
    await expect(
      executePlant(unresolved, {
        account,
        stock,
        vault,
        recipientInput: "nobody.base.eth",
        amountInput: "0.25",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toEqual(new GiftFlowError("recipient_unresolved"));

    await expect(
      executePlant(plantGateway(), {
        account,
        stock,
        vault,
        recipientInput: recipient,
        amountInput: "nope",
        unlockAt: 2_000_000_000n,
        noteHash: `0x${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });
});

describe("executeClaim", () => {
  it("submits a single or batched claim and waits for confirmation", async () => {
    const hash = `0x${"c".repeat(64)}` as const;
    const gateway = {
      claim: vi.fn().mockResolvedValue(hash),
      claimMany: vi.fn().mockResolvedValue(hash),
      waitForClaimReceipt: vi.fn().mockResolvedValue(undefined),
    };
    const phases: string[] = [];
    const claims = [
      { giftId: 4n, recipient, stock, amountRaw: 10n },
      { giftId: 9n, recipient, stock, amountRaw: 20n },
    ];
    await executeClaim(gateway, claims, (phase) => phases.push(phase));
    expect(gateway.claimMany).toHaveBeenCalledWith([4n, 9n]);
    expect(gateway.claim).not.toHaveBeenCalled();
    expect(gateway.waitForClaimReceipt).toHaveBeenCalledWith(hash, claims);
    expect(phases).toEqual(["awaiting_claim", "confirming_claim", "success"]);
  });
});
