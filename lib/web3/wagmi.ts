import { createConfig, fallback, http } from "wagmi";
import type { Transport } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { base, baseSepolia, foundry, mainnet } from "wagmi/chains";

const secondaryRpcUrls: Partial<Record<number, string | undefined>> = {
  [base.id]: process.env.NEXT_PUBLIC_BASE_RPC_URL_SECONDARY,
  [baseSepolia.id]: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL_SECONDARY,
};

export function secondaryRpcUrl(chainId: number): string | null {
  const url = secondaryRpcUrls[chainId];
  return url === undefined || url.length === 0 ? null : url;
}

function transport(chainId: number, primaryUrl: string | undefined): Transport {
  const secondary = secondaryRpcUrl(chainId);
  return secondary === null ? http(primaryUrl) : fallback([http(primaryUrl), http(secondary)]);
}

export const wagmiConfig = createConfig({
  chains: [base, baseSepolia, foundry, mainnet],
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected({ target: "metaMask" }),
    coinbaseWallet({
      appName: "Sowmorrow",
      appLogoUrl: "https://www.sowmorrow.app/wallet-icon.svg",
      preference: { options: "all" },
    }),
  ],
  transports: {
    [base.id]: transport(base.id, process.env.NEXT_PUBLIC_BASE_RPC_URL),
    [baseSepolia.id]: transport(baseSepolia.id, process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL),
    [foundry.id]: http(process.env.NEXT_PUBLIC_ANVIL_RPC_URL ?? "http://127.0.0.1:8545"),
    [mainnet.id]: http(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
