import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, http } from "viem";
import type { Address, Hash } from "viem";
import { base, baseSepolia, foundry, mainnet } from "viem/chains";
import { createConfig, WagmiProvider } from "wagmi";
import type { ResolvedRegister } from "wagmi";
import { connect, disconnect } from "wagmi/actions";
import { mock } from "wagmi/connectors";
import type { AppDeployment } from "@/lib/contracts/config";
import { sowmorrowVaultAbi } from "@/lib/contracts/generated";
import { pendingClaimStorageKey, pendingPlantStorageKey } from "@/lib/contracts/pending";
import { hashGiftNote, toUnlockAt } from "@/lib/gifts";

const mirror = vi.hoisted(() => ({
  attachNote: vi.fn(),
  query: {
    configured: true,
    connected: true,
    data: null as unknown,
    error: null as Error | null,
  },
}));

vi.mock("@/lib/convex/provider", () => ({
  useMirrorMutation: () => mirror.attachNote,
  useMirrorQuery: () => mirror.query,
}));

const account = getAddress("0x1111111111111111111111111111111111111111");
const recipient = getAddress("0x2222222222222222222222222222222222222222");
const stranger = getAddress("0x3333333333333333333333333333333333333333");
const vault = getAddress("0x4444444444444444444444444444444444444444");
const apple = getAddress("0x5555555555555555555555555555555555555555");
const tesla = getAddress("0x6666666666666666666666666666666666666666");
const giftHash = `0x${"ab".repeat(32)}` as Hash;
const claimHash = `0x${"cd".repeat(32)}` as Hash;
const zeroNoteHash = `0x${"00".repeat(32)}` as const;
const nowSeconds = 1_900_000_000n;
const draftDate = "2033-05-18";
const draftUnlockAt = toUnlockAt(draftDate)!;

const publicClient = { current: makeClient() };
const writeMutateAsync = vi.fn<(request: unknown) => Promise<Hash>>();
const switchChainMutate = vi.fn();

vi.mock("motion/react", async () => {
  const react = await import("react");
  const animationProps = new Set([
    "initial",
    "animate",
    "exit",
    "variants",
    "transition",
    "layout",
    "layoutId",
    "custom",
    "whileTap",
    "whileHover",
    "whileFocus",
    "whileInView",
    "onAnimationComplete",
    "onAnimationStart",
  ]);
  const staticElement = (tag: string) =>
    react.forwardRef<unknown, Record<string, unknown>>((props, ref) =>
      react.createElement(
        tag,
        Object.fromEntries(Object.entries({ ...props, ref }).filter(([key]) => !animationProps.has(key))),
      ),
    );
  const cache = new Map<string, unknown>();
  return {
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => {
          if (!cache.has(tag)) cache.set(tag, staticElement(tag));
          return cache.get(tag);
        },
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
    useIsPresent: () => true,
    stagger: () => 0,
  };
});

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    usePublicClient: () => publicClient.current,
    useWriteContract: () => ({ mutateAsync: writeMutateAsync }),
    useSwitchChain: () => ({ mutate: switchChainMutate }),
  };
});

const { GiftWidget } = await import("./gift-widget");

const unreachable = http("http://127.0.0.1:1");
const testConfig = createConfig({
  chains: [base, baseSepolia, foundry, mainnet],
  connectors: [mock({ accounts: [account] })],
  storage: null,
  transports: {
    [base.id]: unreachable,
    [baseSepolia.id]: unreachable,
    [foundry.id]: unreachable,
    [mainnet.id]: unreachable,
  },
});

const deployment: AppDeployment = {
  chainId: 8453,
  networkName: "Base",
  manifestStatus: "active",
  contractVersion: "1.0.0",
  vaultAddress: vault,
  runtimeBytecodeHash: `0x${"ee".repeat(32)}`,
  writesEnabled: true,
  deploymentBlock: 1_000,
  stockAddresses: { AAPLc: apple, TSLAc: tesla },
};

type GiftLog = {
  giftId: bigint;
  sender: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
};

const inboxLogs: GiftLog[] = [];
const giftReads = new Map<string, { status: number; unlockAt: bigint } | "failure">();
const supportedStocks = new Map<string, boolean>();

function giftCreatedLog(entry: {
  giftId: bigint;
  sender: Address;
  recipient: Address;
  stock: Address;
  amountRaw: bigint;
  unlockAt: bigint;
  noteHash?: `0x${string}`;
}) {
  return {
    address: vault,
    topics: encodeEventTopics({
      abi: sowmorrowVaultAbi,
      eventName: "GiftCreated",
      args: { giftId: entry.giftId, sender: entry.sender, recipient: entry.recipient },
    }),
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }],
      [entry.stock, entry.amountRaw, entry.unlockAt, entry.noteHash ?? zeroNoteHash],
    ),
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getBlock: vi.fn().mockResolvedValue({ number: 2_000n, timestamp: nowSeconds }),
    getCode: vi.fn().mockResolvedValue("0x"),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<unknown> => {
      if (functionName === "VERSION") return "1.0.0";
      if (functionName === "decimals") return 6;
      if (functionName === "toRawBalance") return 250_000n;
      if (functionName === "toScaledBalance") return 250_000n;
      if (functionName === "balanceOf") return 10_000_000n;
      if (functionName === "allowance") return 10_000_000n;
      if (functionName === "supportedStock") return true;
      if (functionName === "minGiftAmountRaw") return 0n;
      if (functionName === "creationPaused") return false;
      throw new Error(`unexpected read ${functionName}`);
    }),
    simulateContract: vi.fn().mockResolvedValue({}),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => ({
      status: "success",
      logs:
        hash === giftHash
          ? [
              giftCreatedLog({
                giftId: 7n,
                sender: account,
                recipient,
                stock: apple,
                amountRaw: 250_000n,
                unlockAt: draftUnlockAt,
              }),
            ]
          : [],
    })),
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    getContractEvents: vi.fn(async () =>
      inboxLogs.map((entry) => ({
        args: { ...entry, recipient: account },
      })),
    ),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string; args?: unknown[] }[] }) => {
      const name = contracts[0]?.functionName;
      if (name === "getGift") {
        return contracts.map((call) => {
          const reading = giftReads.get(String(call.args?.[0]));
          if (reading === undefined || reading === "failure") return { status: "failure" };
          const log = inboxLogs.find((entry) => entry.giftId === call.args?.[0])!;
          return {
            status: "success",
            result: {
              sender: log.sender,
              recipient: account,
              stock: log.stock,
              unlockAt: reading.unlockAt,
              status: reading.status,
              amountRaw: log.amountRaw,
              noteHash: zeroNoteHash,
            },
          };
        });
      }
      if (name === "decimals") return contracts.map(() => ({ status: "success", result: 6 }));
      if (name === "supportedStock") {
        return contracts.map((call) => ({
          status: "success",
          result: supportedStocks.get(String(call.args?.[0]).toLowerCase()) ?? true,
        }));
      }
      if (name === "toScaledBalance") {
        return contracts.map((call) => ({ status: "success", result: call.args?.[0] as bigint }));
      }
      if (name === "MAX_BATCH") return [{ status: "success", result: 20n }];
      throw new Error(`unexpected multicall ${name}`);
    }),
    ...overrides,
  };
}

function Harness({ appDeployment = deployment }: { appDeployment?: AppDeployment }) {
  const [face, setFace] = useState<"plant" | "claim">("plant");
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
  );
  return (
    <WagmiProvider config={testConfig as unknown as ResolvedRegister["config"]} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <GiftWidget
          face={face}
          deployment={appDeployment}
          onFaceChange={setFace}
          onPlant={vi.fn()}
          onClaim={vi.fn()}
        />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

async function fillDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("name.base.eth or 0x…"), recipient);
  await user.type(screen.getByPlaceholderText("0.10"), "0.25");
  const opens = screen.getByLabelText("Opens on");
  await user.type(opens, draftDate);
}

beforeEach(async () => {
  window.localStorage.clear();
  inboxLogs.length = 0;
  giftReads.clear();
  supportedStocks.clear();
  writeMutateAsync.mockReset();
  switchChainMutate.mockReset();
  mirror.attachNote.mockReset().mockResolvedValue({ operation: "attached" });
  mirror.query = { configured: true, connected: true, data: null, error: null };
  publicClient.current = makeClient();
  await disconnect(testConfig).catch(() => undefined);
});

describe("Plant state machine", () => {
  it("requires wallet connection before the plant fields become available", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Connect your wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Who is it for" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("group", { name: "Choose a wallet" })).getByRole("button"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Connect your wallet" })).not.toBeInTheDocument(),
    );
    await fillDraft(user);
    expect(screen.getByLabelText("Who is it for")).toHaveValue(recipient);
    expect(screen.getByRole("button", { name: "Review gift" })).toBeEnabled();
  });

  it("blocks review until the draft is complete, then shows a friendly reviewed gift", async () => {
    const user = userEvent.setup();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Review gift" })).toBeDisabled();
    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));

    const review = await screen.findByRole("region", { name: "Gift review" });
    expect(within(review).getByText(recipient)).toBeInTheDocument();
    expect(within(review).queryByText(/raw units/)).not.toBeInTheDocument();
    expect(within(review).queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm and plant" })).toBeEnabled();
  });

  it("destroys the review snapshot when revalidation finds changed onchain terms", async () => {
    const user = userEvent.setup();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await screen.findByRole("region", { name: "Gift review" });

    publicClient.current.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "VERSION" ? "1.0.1" : 250_000n,
    );
    await user.click(screen.getByRole("button", { name: "Confirm and plant" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Review the gift again before signing/);
    expect(screen.queryByRole("region", { name: "Gift review" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review gift" })).toBeInTheDocument();
    expect(writeMutateAsync).not.toHaveBeenCalled();
  });

  it("releases the draft fields again when the sender chooses Edit", async () => {
    const user = userEvent.setup();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await screen.findByRole("region", { name: "Gift review" });
    expect(screen.getByPlaceholderText("0.10")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("region", { name: "Gift review" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("0.10")).toBeEnabled();
  });

  it("requires an explicit acknowledgement before planting to a contract recipient", async () => {
    const user = userEvent.setup();
    publicClient.current = makeClient({ getCode: vi.fn().mockResolvedValue("0x6080") });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await screen.findByRole("region", { name: "Gift review" });

    expect(screen.getByText("This address uses a smart contract.")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Confirm and plant" });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I know this contract can call claim/ }));
    expect(confirm).toBeEnabled();
  });

  it("shows the vault's minimum gift amount as helper text under the amount field", async () => {
    publicClient.current = makeClient({
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === "VERSION") return "1.0.0";
        if (functionName === "decimals") return 6;
        if (functionName === "toRawBalance") return 250_000n;
        if (functionName === "toScaledBalance") return (args?.[0] as bigint) ?? 0n;
        if (functionName === "balanceOf") return 10_000_000n;
        if (functionName === "allowance") return 10_000_000n;
        if (functionName === "supportedStock") return true;
        if (functionName === "minGiftAmountRaw") return 50_000n;
        if (functionName === "creationPaused") return false;
        throw new Error(`unexpected read ${functionName}`);
      }),
    });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    expect(await screen.findByText("Minimum 0.05 AAPLc")).toBeInTheDocument();
  });

  it("rejects reviewing an amount below the vault's minimum gift amount", async () => {
    const user = userEvent.setup();
    publicClient.current = makeClient({
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === "VERSION") return "1.0.0";
        if (functionName === "decimals") return 6;
        if (functionName === "toRawBalance") return 250_000n;
        if (functionName === "toScaledBalance") return (args?.[0] as bigint) ?? 0n;
        if (functionName === "balanceOf") return 10_000_000n;
        if (functionName === "allowance") return 10_000_000n;
        if (functionName === "supportedStock") return true;
        if (functionName === "minGiftAmountRaw") return 300_000n;
        if (functionName === "creationPaused") return false;
        throw new Error(`unexpected read ${functionName}`);
      }),
    });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/minimum gift for this stock is 0.3 shares/);
    expect(screen.queryByRole("region", { name: "Gift review" })).not.toBeInTheDocument();
  });

  it("plants a gift for a wallet recipient without any extra acknowledgement", async () => {
    const user = userEvent.setup();
    writeMutateAsync.mockResolvedValue(giftHash);
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await screen.findByRole("region", { name: "Gift review" });
    expect(screen.queryByText("This address uses a smart contract.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm and plant" }));

    const walletButton = await screen.findByRole("button", { name: "Plant gift in wallet" });
    expect(writeMutateAsync).not.toHaveBeenCalled();
    await user.click(walletButton);
    expect(await screen.findByText("It’s in the ground.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the gift page" })).toHaveAttribute(
      "href",
      `/gift/8453/${vault}/7`,
    );
    expect(window.localStorage.getItem(pendingPlantStorageKey(8453, vault, account))).toBeNull();
  });

  it("requires a new review when a prepared wallet action has expired", async () => {
    const user = userEvent.setup();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await fillDraft(user);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and plant" }));
    const button = await screen.findByRole("button", { name: "Plant gift in wallet" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      await user.click(button);
      expect(await screen.findByRole("button", { name: "Review gift" })).toBeEnabled();
      expect(writeMutateAsync).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("waits for the indexed gift before attaching its note", async () => {
    const user = userEvent.setup();
    const note = "The first seed planted...";
    writeMutateAsync.mockResolvedValue(giftHash);
    publicClient.current = makeClient({
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        logs: [
          giftCreatedLog({
            giftId: 7n,
            sender: account,
            recipient,
            stock: apple,
            amountRaw: 250_000n,
            unlockAt: draftUnlockAt,
            noteHash: hashGiftNote(note),
          }),
        ],
      })),
    });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    const rendered = render(<Harness />);

    await fillDraft(user);
    await user.type(screen.getByLabelText(/Gift note/), note);
    await user.click(screen.getByRole("button", { name: "Review gift" }));
    await user.click(await screen.findByRole("button", { name: "Confirm and plant" }));

    const walletButton = await screen.findByRole("button", { name: "Plant gift in wallet" });
    expect(writeMutateAsync).not.toHaveBeenCalled();
    await user.click(walletButton);
    expect(await screen.findByText("It’s in the ground.")).toBeInTheDocument();
    expect(screen.getByText(/Saving the note once the gift appears in history/)).toBeInTheDocument();
    expect(mirror.attachNote).not.toHaveBeenCalled();

    mirror.query = {
      configured: true,
      connected: true,
      data: { gift: { giftIdDecimal: "7" }, note: null },
      error: null,
    };
    rendered.rerender(<Harness />);

    await waitFor(() =>
      expect(mirror.attachNote).toHaveBeenCalledWith({
        chainId: 8453,
        vault,
        giftId: "7",
        note,
      }),
    );
    expect(await screen.findByText("The public note is saved.")).toBeInTheDocument();
  });

  it("recovers a gift transaction persisted by an earlier session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      pendingPlantStorageKey(8453, vault, account),
      JSON.stringify({
        version: 1,
        kind: "gift",
        chainId: 8453,
        hash: giftHash,
        vault,
        account,
        recipient,
        stock: apple,
        amountRaw: "250000",
        unlockAt: "2000000000",
        noteHash: zeroNoteHash,
        amountInput: "0.25",
        transferableAmount: "0.25",
        symbol: "AAPLc",
        submittedAt: 1,
      }),
    );
    publicClient.current = makeClient({
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        logs: [
          giftCreatedLog({
            giftId: 7n,
            sender: account,
            recipient,
            stock: apple,
            amountRaw: 250_000n,
            unlockAt: 2_000_000_000n,
          }),
        ],
      }),
    });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);

    expect(await screen.findByRole("region", { name: "Submitted gift recovery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmation required" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Check gift" }));
    expect(await screen.findByText("It’s in the ground.")).toBeInTheDocument();
    expect(window.localStorage.getItem(pendingPlantStorageKey(8453, vault, account))).toBeNull();
  });
});

describe("Claim inbox", () => {
  const readyGift = { giftId: 1n, sender: recipient, stock: apple, amountRaw: 900_000n, unlockAt: 1n };
  const lockedGift = {
    giftId: 2n,
    sender: recipient,
    stock: apple,
    amountRaw: 800_000n,
    unlockAt: 2_000_000_000n,
  };
  const retiredGift = {
    giftId: 3n,
    sender: recipient,
    stock: tesla,
    amountRaw: 700_000n,
    unlockAt: 1n,
  };
  const dustGift = { giftId: 4n, sender: stranger, stock: apple, amountRaw: 1n, unlockAt: 1n };

  function seedInbox() {
    inboxLogs.push(readyGift, lockedGift, retiredGift, dustGift);
    giftReads.set("1", { status: 1, unlockAt: 1n });
    giftReads.set("2", { status: 1, unlockAt: 2_000_000_000n });
    giftReads.set("3", { status: 1, unlockAt: 1n });
    giftReads.set("4", { status: 1, unlockAt: 1n });
    supportedStocks.set(tesla.toLowerCase(), false);
  }

  async function openClaim(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Claim" }));
    return screen.findByRole("tabpanel", { name: "Claim" });
  }

  it("groups by stock, marks each row state, and never selects anything on its own", async () => {
    const user = userEvent.setup();
    seedInbox();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    expect(await screen.findByRole("region", { name: "AAPLc gifts" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "TSLAc gifts" })).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();
    expect(
      screen.getByText("This stock is no longer open for new gifts. This gift is still yours to claim."),
    ).toBeInTheDocument();
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Select gifts to claim" })).toBeDisabled();
  });

  it("hides dust and unfamiliar senders behind a disclosure that is closed by default", async () => {
    const user = userEvent.setup();
    seedInbox();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    const disclosure = await screen.findByRole("button", { name: "Show 1 small gift" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(screen.getByRole("button", { name: "Hide 1 small gift" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("selects a ready gift with the keyboard and reflects it in the claim button", async () => {
    const user = userEvent.setup();
    seedInbox();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    const readyCheckbox = await screen.findByRole("checkbox", { name: /0.9 AAPLc/ });
    readyCheckbox.focus();
    await user.keyboard(" ");

    expect(readyCheckbox).toBeChecked();
    expect(screen.getByRole("button", { name: "Claim 1 selected gift" })).toBeEnabled();
  });

  it("explains why a locked gift cannot be selected", async () => {
    const user = userEvent.setup();
    seedInbox();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    const lockedCheckbox = await screen.findByRole("checkbox", { name: /0.8 AAPLc/ });
    expect(lockedCheckbox).toBeDisabled();
    expect(lockedCheckbox).toHaveAccessibleDescription(
      "Locked until the opening day, so it cannot be claimed yet.",
    );
  });

  it("marks a gift whose vault read failed as unreadable and excludes it", async () => {
    const user = userEvent.setup();
    inboxLogs.push(readyGift, lockedGift);
    giftReads.set("1", "failure");
    giftReads.set("2", { status: 1, unlockAt: 2_000_000_000n });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    expect(await screen.findByText("unreadable")).toBeInTheDocument();
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
  });

  it("shows a claim submitted from this browser as confirming and blocks a second submission", async () => {
    const user = userEvent.setup();
    seedInbox();
    window.localStorage.setItem(
      pendingClaimStorageKey(8453, vault, account),
      JSON.stringify({
        version: 1,
        chainId: 8453,
        hash: claimHash,
        vault,
        account,
        giftIds: ["1"],
        submittedAt: 1,
      }),
    );
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    expect(await screen.findByRole("region", { name: "Submitted claim recovery" })).toBeInTheDocument();
    expect(await screen.findByText("confirming")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmation required" })).toBeDisabled();
  });

  it("claims the exact selection through the vault and clears it afterwards", async () => {
    const user = userEvent.setup();
    seedInbox();
    writeMutateAsync.mockResolvedValue(claimHash);
    publicClient.current = makeClient({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        logs: [
          {
            address: vault,
            topics: encodeEventTopics({
              abi: sowmorrowVaultAbi,
              eventName: "GiftClaimed",
              args: { giftId: 1n, recipient: account, stock: apple },
            }),
            data: encodeAbiParameters([{ type: "uint256" }], [900_000n]),
          },
        ],
      }),
    });
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    await user.click(await screen.findByRole("checkbox", { name: /0.9 AAPLc/ }));
    await user.click(screen.getByRole("button", { name: "Claim 1 selected gift" }));

    expect(await screen.findByText(/Claimed safely to this wallet/)).toBeInTheDocument();
    await waitFor(() =>
      expect(writeMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ functionName: "claim" })),
    );
    expect(window.localStorage.getItem(pendingClaimStorageKey(8453, vault, account))).toBeNull();
  });

  it("offers the network switch instead of reading another chain for this account", async () => {
    const user = userEvent.setup();
    seedInbox();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness appDeployment={{ ...deployment, chainId: 84532, networkName: "Base Sepolia" }} />);
    await openClaim(user);

    expect(await screen.findByText("Your wallet is on another network.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Switch to Base Sepolia" })[0]);
    expect(switchChainMutate).toHaveBeenCalledWith({ chainId: 84532 });
  });

  it("keeps the mirror notice visible while no Convex deployment is configured", async () => {
    const user = userEvent.setup();
    await connect(testConfig, { connector: testConfig.connectors[0] });
    render(<Harness />);
    await openClaim(user);

    expect(await screen.findByTestId("mirror-notice")).toBeInTheDocument();
  });
});

it("an indexed old gift appears without scanning empty block pages", async () => {
  const user = userEvent.setup();
  inboxLogs.push({ giftId: 1n, sender: recipient, stock: apple, amountRaw: 900_000n, unlockAt: 1n });
  giftReads.set("1", { status: 1, unlockAt: 1n });
  publicClient.current = makeClient({
    getBlock: vi.fn().mockResolvedValue({ number: 128000n, timestamp: nowSeconds }),
    getContractEvents: vi.fn().mockResolvedValue([]),
  });
  mirror.query.data = {
    page: [
      {
        giftIdDecimal: "1",
        vaultAddressLower: vault.toLowerCase(),
        recipientLower: account.toLowerCase(),
        senderLower: recipient.toLowerCase(),
        stockLower: apple.toLowerCase(),
        amountRawDecimal: "900000",
        state: "active",
        unlockAt: 1,
        createdBlock: 1001,
      },
    ],
  };
  await connect(testConfig, { connector: testConfig.connectors[0] });
  render(<Harness />);
  await user.click(screen.getByRole("tab", { name: "Claim" }));
  await waitFor(() => expect(screen.queryAllByRole("checkbox")).toHaveLength(1));
});
it("a submitted gift no longer blocks a disconnected wallet", async () => {
  window.localStorage.setItem(
    pendingPlantStorageKey(8453, vault, account),
    JSON.stringify({
      version: 1,
      kind: "gift",
      chainId: 8453,
      hash: giftHash,
      vault,
      account,
      recipient,
      stock: apple,
      amountRaw: "250000",
      unlockAt: "2000000000",
      noteHash: zeroNoteHash,
      amountInput: "0.25",
      transferableAmount: "0.25",
      symbol: "AAPLc",
      submittedAt: 1,
    }),
  );
  await connect(testConfig, { connector: testConfig.connectors[0] });
  render(<Harness />);
  await screen.findByRole("region", { name: "Submitted gift recovery" });
  await disconnect(testConfig);
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Submitted gift recovery" })).not.toBeInTheDocument(),
  );
});
it("note remains recoverable after reload before indexing", async () => {
  const user = userEvent.setup();
  const note = "Reload must preserve this note";
  writeMutateAsync.mockResolvedValue(giftHash);
  publicClient.current = makeClient({
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      logs: [
        giftCreatedLog({
          giftId: 7n,
          sender: account,
          recipient,
          stock: apple,
          amountRaw: 250000n,
          unlockAt: draftUnlockAt,
          noteHash: hashGiftNote(note),
        }),
      ],
    }),
  });
  await connect(testConfig, { connector: testConfig.connectors[0] });
  const rendered = render(<Harness />);
  await fillDraft(user);
  await user.type(screen.getByLabelText(/Gift note/), note);
  await user.click(screen.getByRole("button", { name: "Review gift" }));
  await user.click(await screen.findByRole("button", { name: "Confirm and plant" }));
  await user.click(await screen.findByRole("button", { name: "Plant gift in wallet" }));
  await screen.findByText(/Saving the note once the gift appears in history/);
  rendered.unmount();
  mirror.query.data = { gift: { giftIdDecimal: "7" }, note: null };
  render(<Harness />);
  await waitFor(() => expect(mirror.attachNote).toHaveBeenCalled());
});
