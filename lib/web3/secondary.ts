import { createPublicClient, http } from "viem";
import type { Chain, Hash } from "viem";
import { base, baseSepolia } from "viem/chains";
import { secondaryRpcUrl } from "./wagmi";

const secondaryChains: Partial<Record<number, Chain>> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
};

const clientCache = new Map<number, ReturnType<typeof createPublicClient> | null>();

export function secondaryPublicClient(chainId: number) {
  const cached = clientCache.get(chainId);
  if (cached !== undefined) return cached;
  const url = secondaryRpcUrl(chainId);
  const chain = secondaryChains[chainId];
  const client =
    url === null || chain === undefined ? null : createPublicClient({ chain, transport: http(url) });
  clientCache.set(chainId, client);
  return client;
}

export type ReceiptReader<receipt> = {
  getTransactionReceipt: (parameters: { hash: Hash }) => Promise<receipt>;
};

export async function readReceiptWithFallback<receipt>(
  readers: readonly (ReceiptReader<receipt> | null | undefined)[],
  hash: Hash,
): Promise<receipt> {
  let firstFailure: unknown = null;
  let attempted = false;
  for (const reader of readers) {
    if (!reader) continue;
    attempted = true;
    try {
      return await reader.getTransactionReceipt({ hash });
    } catch (caught) {
      if (firstFailure === null) firstFailure = caught;
    }
  }
  if (!attempted) throw new Error("No transaction receipt reader is configured");
  throw firstFailure;
}
