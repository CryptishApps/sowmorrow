import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, getAddress } from "viem";
import { sowmorrowVaultAbi } from "@/lib/contracts/generated";
import type { GiftRouteTarget } from "@/lib/contracts/gift-link";

const vault = getAddress("0x4444444444444444444444444444444444444444");
const apple = getAddress("0x5555555555555555555555555555555555555555");
const sender = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");

const publicClient = { current: makeClient() };

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return { ...actual, usePublicClient: () => publicClient.current };
});

const { GiftDetail } = await import("./gift-detail");

const activeTarget: GiftRouteTarget = {
  chainId: 84532,
  networkName: "Base Sepolia",
  vault,
  giftId: "7",
  manifestStatus: "active",
  vaultIsManifestVault: true,
  stockAddresses: { AAPLc: apple },
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlock: vi.fn().mockResolvedValue({ number: 90n, timestamp: 1_900_000_000n }),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getGift") {
        return {
          sender,
          recipient,
          stock: apple,
          unlockAt: 1_800_000_000n,
          status: 1,
          amountRaw: 250_000n,
          noteHash: `0x${"00".repeat(32)}`,
        };
      }
      if (functionName === "decimals") return 6;
      if (functionName === "toScaledBalance") return 250_000n;
      throw new Error(`unexpected read ${functionName}`);
    }),
    ...overrides,
  };
}

function revert(errorName: string) {
  const reverted = new ContractFunctionRevertedError({
    abi: sowmorrowVaultAbi,
    data: undefined,
    functionName: "getGift",
    message: undefined,
  });
  Object.assign(reverted, { data: { abiItem: undefined, errorName, args: [] } });
  return new ContractFunctionExecutionError(reverted, {
    abi: sowmorrowVaultAbi,
    functionName: "getGift",
    args: [7n],
  });
}

function renderDetail(target: GiftRouteTarget = activeTarget) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GiftDetail target={target} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  publicClient.current = makeClient();
});

describe("GiftDetail", () => {
  it("reads the gift from chain and shows its state without a wallet", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: "0.25 AAPLc" })).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.getByText(sender)).toBeInTheDocument();
    expect(screen.getByText(recipient)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Sowmorrow" })).toHaveAttribute("href", "/");
  });

  it("shows a locked gift against the observed block timestamp", async () => {
    publicClient.current = makeClient({
      getBlock: vi.fn().mockResolvedValue({ number: 90n, timestamp: 1_000n }),
    });
    renderDetail();

    expect(await screen.findByText("locked")).toBeInTheDocument();
  });

  it("renders a not-found state for a gift number the vault never issued", async () => {
    publicClient.current = makeClient({
      readContract: vi.fn().mockRejectedValue(revert("GiftNotFound")),
    });
    renderDetail();

    expect(await screen.findByTestId("gift-detail-error")).toHaveTextContent("No gift with that number.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry when the RPC itself fails", async () => {
    const user = userEvent.setup();
    publicClient.current = makeClient({
      readContract: vi.fn().mockRejectedValue(new Error("network down")),
    });
    renderDetail();

    expect(await screen.findByTestId("gift-detail-error")).toHaveTextContent("The vault could not be read.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(publicClient.current.readContract).toHaveBeenCalled();
  });

  it("explains a still pending manifest instead of reading a vault that is not deployed", async () => {
    renderDetail({
      ...activeTarget,
      chainId: 8453,
      networkName: "Base",
      manifestStatus: "pending",
      vaultIsManifestVault: false,
    });

    expect(screen.getByTestId("gift-pending-manifest")).toBeInTheDocument();
    expect(screen.getByText(vault)).toBeInTheDocument();
    expect(publicClient.current.readContract).not.toHaveBeenCalled();
  });

  it("says the mirror is off when no Convex deployment is configured", async () => {
    renderDetail();

    expect(await screen.findByTestId("mirror-notice")).toBeInTheDocument();
  });
});
