import { expect, it } from "vitest";
import { wagmiConfig } from "./wagmi";

it("offers only explicit MetaMask and Coinbase connectors", () => {
  expect(wagmiConfig.connectors.map((connector) => connector.id).sort()).toEqual([
    "coinbaseWalletSDK",
    "metaMask",
  ]);
});
