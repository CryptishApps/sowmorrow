import { base, baseSepolia, foundry, mainnet, sepolia } from "viem/chains";

export function identityNetwork(chainId: typeof base.id | typeof baseSepolia.id | typeof foundry.id) {
  return chainId === base.id
    ? {
        baseChainId: base.id,
        ensChainId: mainnet.id,
        registry: "0xb94704422c2a1e396835a571837aa5ae53285a95" as const,
        placeholder: "name.base.eth or 0x…",
      }
    : {
        baseChainId: baseSepolia.id,
        ensChainId: sepolia.id,
        registry: "0x1493b2567056c2181630115660963E13A8E32735" as const,
        placeholder: "name.basetest.eth or 0x…",
      };
}
