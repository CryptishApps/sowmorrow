import { expect, test } from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  toHex,
} from "viem";
import type { Hex } from "viem";
import { ib20Abi, ib20AssetAbi, sowmorrowVaultAbi } from "../../lib/contracts/generated";
import manifest from "../../contracts/deployments/base-sepolia-84532.json";

const account = "0x1111111111111111111111111111111111111111";
const stock = manifest.stocks[0].address as Hex;
const vault = manifest.vaultAddress as Hex;
const blockHash = `0x${"aa".repeat(32)}` as Hex;
const abi = [...sowmorrowVaultAbi, ...ib20Abi, ...ib20AssetAbi, ...multicall3Abi];

for (const wallet of ["Coinbase Wallet", "MetaMask"]) {
  test(`${wallet} connects, approves, plants, and claims through the shared gift page`, async ({ page }) => {
    const violations: string[] = [];
    await page.exposeFunction("recordCspViolation", (directive: string) => violations.push(directive));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as unknown as { recordCspViolation: (directive: string) => void }).recordCspViolation(
          JSON.stringify({
            directive: event.violatedDirective,
            blockedURI: event.blockedURI,
            sourceFile: event.sourceFile,
          }),
        );
      });
    });
    let allowance = 0n;
    let amount = 0n;
    let unlockAt = 0n;
    let claimed = false;
    let now = BigInt(Math.floor(Date.now() / 1000));
    const receipts = new Map<string, unknown>();
    const writes: string[] = [];
    const block = () => ({
      number: toHex(50_000_000),
      hash: blockHash,
      parentHash: blockHash,
      timestamp: toHex(now),
      transactions: [],
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      baseFeePerGas: "0x1",
      difficulty: "0x0",
      extraData: "0x",
      miner: account,
      nonce: "0x0000000000000000",
      receiptsRoot: blockHash,
      sha3Uncles: blockHash,
      stateRoot: blockHash,
      transactionsRoot: blockHash,
      logsBloom: `0x${"00".repeat(256)}`,
      size: "0x1",
      uncles: [],
    });
    const call = (data: Hex): Hex => {
      const decoded = decodeFunctionData({ abi, data });
      if (decoded.functionName === "aggregate3") {
        const results = decoded.args[0].map((entry) => ({ success: true, returnData: call(entry.callData) }));
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      }
      switch (decoded.functionName) {
        case "VERSION":
          return encodeFunctionResult({ abi: sowmorrowVaultAbi, functionName: "VERSION", result: "1.0.0" });
        case "getGift":
          return encodeFunctionResult({
            abi: sowmorrowVaultAbi,
            functionName: "getGift",
            result: {
              sender: account,
              recipient: account,
              stock,
              unlockAt,
              status: claimed ? 2 : 1,
              amountRaw: amount,
              noteHash: `0x${"00".repeat(32)}`,
            },
          });
        case "decimals":
          return encodeAbiParameters([{ type: "uint8" }], [18]);
        case "balanceOf":
          return encodeAbiParameters([{ type: "uint256" }], [10n ** 20n]);
        case "allowance":
          return encodeAbiParameters([{ type: "uint256" }], [allowance]);
        case "toRawBalance":
        case "toScaledBalance":
          return encodeAbiParameters([{ type: "uint256" }], [decoded.args[0]]);
        case "supportedStock":
          return encodeAbiParameters([{ type: "bool" }], [true]);
        case "creationPaused":
          return encodeAbiParameters([{ type: "bool" }], [false]);
        case "minGiftAmountRaw":
          return encodeAbiParameters([{ type: "uint256" }], [10n ** 16n]);
        case "MAX_BATCH":
          return encodeAbiParameters([{ type: "uint256" }], [20n]);
        case "approve":
          return encodeAbiParameters([{ type: "bool" }], [true]);
        case "createGift":
          return encodeAbiParameters([{ type: "uint256" }], [7n]);
        case "claim":
          return "0x";
        default:
          throw new Error(`Unhandled contract call: ${decoded.functionName}`);
      }
    };
    const rpc = async ({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> => {
      switch (method) {
        case "eth_chainId":
          return "0x14a34";
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account];
        case "wallet_switchEthereumChain":
          return null;
        case "wallet_getCapabilities":
          return {};
        case "eth_getCode":
          return "0x";
        case "eth_blockNumber":
          return toHex(50_000_000);
        case "eth_getBlockByNumber":
          return block();
        case "eth_getLogs":
          return [];
        case "eth_call":
          return call((params[0] as { data: Hex }).data);
        case "eth_getTransactionReceipt":
          return receipts.get(String(params[0])) ?? null;
        case "eth_sendTransaction": {
          const tx = params[0] as { data: Hex; from: string; to: string };
          expect(tx.from.toLowerCase()).toBe(account);
          const decoded = decodeFunctionData({ abi, data: tx.data });
          writes.push(decoded.functionName);
          const hash = `0x${writes.length.toString(16).padStart(64, "0")}`;
          let logs: unknown[] = [];
          if (decoded.functionName === "approve") allowance = decoded.args[1];
          if (decoded.functionName === "createGift") {
            amount = decoded.args[2];
            unlockAt = decoded.args[3];
            logs = [
              {
                address: vault,
                topics: encodeEventTopics({
                  abi: sowmorrowVaultAbi,
                  eventName: "GiftCreated",
                  args: { giftId: 7n, sender: account, recipient: account },
                }),
                data: encodeAbiParameters(
                  [{ type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }],
                  [stock, amount, unlockAt, decoded.args[4]],
                ),
              },
            ];
          }
          if (decoded.functionName === "claim") {
            expect(now >= unlockAt).toBe(true);
            claimed = true;
            logs = [
              {
                address: vault,
                topics: encodeEventTopics({
                  abi: sowmorrowVaultAbi,
                  eventName: "GiftClaimed",
                  args: { giftId: 7n, recipient: account, stock },
                }),
                data: encodeAbiParameters([{ type: "uint256" }], [amount]),
              },
            ];
          }
          receipts.set(hash, {
            transactionHash: hash,
            blockHash,
            blockNumber: toHex(50_000_000),
            transactionIndex: "0x0",
            from: account,
            to: tx.to,
            status: "0x1",
            gasUsed: "0x5208",
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            type: "0x2",
            contractAddress: null,
            logsBloom: `0x${"00".repeat(256)}`,
            logs: logs.map((log, index) => ({
              ...(log as object),
              transactionHash: hash,
              transactionIndex: "0x0",
              logIndex: toHex(index),
              blockHash,
              blockNumber: toHex(50_000_000),
              removed: false,
            })),
          });
          return hash;
        }
        default:
          throw new Error(`Unhandled RPC: ${method}`);
      }
    };
    await page.exposeFunction("testWalletRpc", rpc);
    await page.addInitScript((wallet) => {
      const target = window as unknown as {
        testWalletRpc: (request: unknown) => Promise<unknown>;
        coinbaseWalletExtension: unknown;
        ethereum: unknown;
      };
      const provider = {
        isCoinbaseWallet: wallet === "Coinbase Wallet",
        isMetaMask: wallet === "MetaMask",
        request: (request: { method: string }) => {
          if (["wallet_getSession", "wallet_createSession", "wallet_getSnaps"].includes(request.method))
            throw Object.assign(new Error("Unsupported method"), { code: -32601 });
          return target.testWalletRpc(request);
        },
        on() {},
        removeListener() {},
        disconnect() {},
        close() {},
      };
      if (wallet === "Coinbase Wallet") target.coinbaseWalletExtension = provider;
      else {
        target.ethereum = provider;
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: {
                info: {
                  uuid: "350670db-19fa-4704-a166-e52e178b59d2",
                  name: "MetaMask",
                  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
                  rdns: "io.metamask",
                },
                provider,
              },
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      }
    }, wallet);
    await page.route("**/test-rpc", async (route) => {
      const request = route.request().postDataJSON();
      const respond = async (entry: { id: number; method: string; params?: unknown[] }) => ({
        jsonrpc: "2.0",
        id: entry.id,
        result: await rpc(entry),
      });
      await route.fulfill({
        json: Array.isArray(request) ? await Promise.all(request.map(respond)) : await respond(request),
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (wallet === "MetaMask") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
    await page.screenshot({
      path: `.cache/wallet-deployment/wallet-gate-${wallet === "MetaMask" ? "mobile" : "desktop"}.png`,
    });
    await expect(page.getByRole("textbox", { name: "Who is it for" })).toHaveCount(0);
    await expect(page.getByTestId("connector-picker").getByRole("button")).toHaveCount(2);
    await page
      .getByRole("button", { name: wallet === "Coinbase Wallet" ? "Base" : wallet, exact: true })
      .click();
    await expect(page.getByRole("button", { name: /disconnect/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connect your wallet" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Who is it for" })).toBeVisible();
    await page.getByLabel("Who is it for").fill(account);
    await page.getByPlaceholder("0.10").fill("0.25");
    const date = new Date();
    date.setDate(date.getDate() + 2);
    await page.getByLabel("Opens on").fill(date.toISOString().slice(0, 10));
    await page.getByRole("button", { name: "Review gift", exact: true }).click();
    await expect(page.getByRole("region", { name: "Gift review" })).toContainText(account);
    await expect(
      page.getByRole("region", { name: "Gift review" }).getByText(account, { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    if (wallet === "Coinbase Wallet")
      await page.screenshot({ path: ".cache/launch-review/enabled-review.png", fullPage: true });
    await page.getByRole("button", { name: "Confirm and plant" }).click();
    await expect(page.getByText("It’s in the ground.")).toBeVisible();
    expect(writes).toEqual(["approve", "createGift"]);
    now = unlockAt + 1n;
    await page.getByRole("link", { name: "Open the gift page" }).click();
    await page
      .getByRole("button", { name: wallet === "Coinbase Wallet" ? "Base" : wallet, exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Claim 1 selected gift" })).toBeEnabled();
    await expect(page.getByRole("checkbox")).toBeVisible();
    if (wallet === "Coinbase Wallet")
      await page.screenshot({ path: ".cache/launch-review/direct-claim.png", fullPage: true });
    await page.getByRole("button", { name: "Claim 1 selected gift" }).click();
    await expect(page.getByText(/Claimed safely to this wallet|already claimed/i).first()).toBeVisible();
    expect(writes).toEqual(["approve", "createGift", "claim"]);
    expect(violations).toEqual([]);
  });
}
