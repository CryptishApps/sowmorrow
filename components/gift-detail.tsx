"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import type { Address } from "viem";
import { ClaimFace } from "@/components/claim-inbox";
import { getAppDeployment } from "@/lib/contracts/config";
import { hashGiftNote } from "@/lib/gifts";
import { MirrorNotice, shortAddress, Spinner, StockDot } from "@/components/gift-chrome";
import { HeroBackdrop } from "@/components/hero-backdrop";
import { Logo } from "@/components/logo";
import { revertedErrorName } from "@/lib/contracts/errors";
import { ib20Abi, ib20AssetAbi, sowmorrowVaultAbi } from "@/lib/contracts/generated";
import type { GiftRouteTarget } from "@/lib/contracts/gift-link";
import { mirrorApi, mirrorConfigured } from "@/lib/convex/api";
import { useMirrorQuery } from "@/lib/convex/provider";
import { formatUnlockReview } from "@/lib/gifts";
import { stocks } from "@/lib/stocks";

type GiftReading = {
  sender: Address;
  recipient: Address;
  stock: Address;
  unlockAt: bigint;
  status: number;
  amountRaw: bigint;
  noteHash: `0x${string}`;
  amountScaled: bigint | null;
  decimals: number | null;
  blockTimestamp: bigint;
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-sky-deep px-4 py-10">
      <HeroBackdrop />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[30dvh] bg-gradient-to-t from-cream via-cream/50 to-transparent" />
      <div className="relative z-10 flex w-full max-w-[560px] flex-col items-center">
        <Link href="/" aria-label="Sowmorrow home">
          <Logo />
        </Link>
        <section className="mt-6 w-full rounded-[26px] border border-ink/10 bg-cream p-6 text-left text-ink shadow-card sm:p-7">
          {children}
        </section>
      </div>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="mt-5 inline-block text-[12px] font-extrabold text-sky-deep underline underline-offset-2"
    >
      Back to Sowmorrow
    </Link>
  );
}

export function GiftDetail({ target }: { target: GiftRouteTarget }) {
  const client = usePublicClient({ chainId: target.chainId });
  const deployment = getAppDeployment();
  const readable = target.manifestStatus !== "pending";

  const gift = useQuery({
    queryKey: ["gift-detail", target.chainId, target.vault, target.giftId],
    enabled: readable && client !== undefined,
    queryFn: async (): Promise<GiftReading> => {
      if (!client) throw new Error("No configured client for this network");
      const [block, reading] = await Promise.all([
        client.getBlock({ blockTag: "latest" }),
        client.readContract({
          address: target.vault,
          abi: sowmorrowVaultAbi,
          functionName: "getGift",
          args: [BigInt(target.giftId)],
        }),
      ]);
      const [decimals, amountScaled] = await Promise.all([
        client
          .readContract({ address: reading.stock, abi: ib20Abi, functionName: "decimals" })
          .catch(() => null),
        client
          .readContract({
            address: reading.stock,
            abi: ib20AssetAbi,
            functionName: "toScaledBalance",
            args: [reading.amountRaw],
          })
          .catch(() => null),
      ]);
      return {
        sender: reading.sender,
        recipient: reading.recipient,
        stock: reading.stock,
        unlockAt: reading.unlockAt,
        status: reading.status,
        amountRaw: reading.amountRaw,
        noteHash: reading.noteHash,
        amountScaled,
        decimals,
        blockTimestamp: block.timestamp,
      };
    },
    retry: false,
  });

  const mirror = useMirrorQuery(
    mirrorApi.giftDetail,
    target.vaultIsManifestVault
      ? { chainId: target.chainId, vault: target.vault, giftId: target.giftId }
      : null,
  );

  const selectedStock =
    gift.data === undefined
      ? null
      : (stocks.find(
          (stock) => target.stockAddresses[stock.symbol]?.toLowerCase() === gift.data.stock.toLowerCase(),
        ) ?? null);
  const symbol = gift.data === undefined ? null : (selectedStock?.symbol ?? "B20");

  const header = (
    <div className="flex items-center justify-between gap-3">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-meadow/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-meadow-deep">
        <span className="size-1.5 rounded-full bg-meadow" aria-hidden="true" />
        {target.networkName}
        {target.manifestStatus !== "active" && ` ${target.manifestStatus}`}
      </span>
      <span className="font-mono text-[10px] text-ink-soft">Gift #{target.giftId}</span>
    </div>
  );

  if (!readable) {
    return (
      <Shell>
        {header}
        <h1 className="display mt-4 text-[30px] leading-tight">This vault is not planted yet.</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft" data-testid="gift-pending-manifest">
          {target.networkName} has no active reviewed Sowmorrow deployment, so there is no gift to read at
          this address yet. The link stays valid and starts working the moment a reviewed manifest goes
          active.
        </p>
        <dl className="mt-4 grid gap-1 text-[11px] text-ink-soft">
          <dt className="font-extrabold text-ink">Vault in this link</dt>
          <dd className="font-mono text-[10px] text-ink">{shortAddress(target.vault)}</dd>
        </dl>
        <BackLink />
      </Shell>
    );
  }

  if (gift.isPending) {
    return (
      <Shell>
        {header}
        <div className="mt-6 flex items-center gap-3 text-[13px] font-extrabold text-ink-soft" role="status">
          <Spinner />
          Reading the vault&hellip;
        </div>
      </Shell>
    );
  }

  if (gift.isError) {
    const missing = revertedErrorName(gift.error) === "GiftNotFound";
    return (
      <Shell>
        {header}
        <h1 className="display mt-4 text-[30px] leading-tight" data-testid="gift-detail-error">
          {missing ? "No gift with that number." : "The vault could not be read."}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
          {missing
            ? "This vault has never held a gift with this number. Check the link you were sent."
            : "The configured Base RPC did not answer. Nothing about this gift has changed."}
        </p>
        {!missing && (
          <button type="button" onClick={() => void gift.refetch()} className="primary-button mt-4 block">
            Try again
          </button>
        )}
        <BackLink />
      </Shell>
    );
  }

  const reading = gift.data;
  const claimed = reading.status === 2;
  const unlocked = reading.unlockAt <= reading.blockTimestamp;
  const stateLabel = claimed ? "claimed" : unlocked ? "ready" : "locked";
  const amount =
    reading.amountScaled !== null && reading.decimals !== null
      ? `${formatUnits(reading.amountScaled, reading.decimals)} ${symbol}`
      : "Amount unavailable";
  const opens = formatUnlockReview(reading.unlockAt).localDate;

  return (
    <Shell>
      {header}
      <div className="mt-4 flex items-center gap-3">
        {symbol && <StockDot symbol={symbol} />}
        <div>
          <h1 className="display text-[30px] leading-tight">{amount}</h1>
          <p className="text-[12px] text-ink-soft">
            <span className={`gift-state gift-state-${stateLabel}`}>{stateLabel}</span>
            <span className="ml-2">
              {claimed
                ? "already claimed by the recipient"
                : unlocked
                  ? "open for the recipient to claim"
                  : "waiting for its opening day"}
            </span>
          </p>
        </div>
      </div>

      <dl className="mt-5 grid gap-2.5 text-[11px] leading-relaxed text-ink-soft">
        <div>
          <dt className="font-extrabold text-ink">From</dt>
          <dd className="font-mono text-[10px] text-ink">{shortAddress(reading.sender)}</dd>
        </div>
        <div>
          <dt className="font-extrabold text-ink">For</dt>
          <dd className="font-mono text-[10px] text-ink">{shortAddress(reading.recipient)}</dd>
        </div>
        <div>
          <dt className="font-extrabold text-ink">Stock</dt>
          <dd>{selectedStock ? `${selectedStock.name} · ${selectedStock.symbol}` : "B20 stock"}</dd>
        </div>
        <div>
          <dt className="font-extrabold text-ink">Opens</dt>
          <dd>{opens}</dd>
        </div>
      </dl>

      {mirror.data?.note && gift.data && hashGiftNote(mirror.data.note.noteUtf8) === gift.data.noteHash ? (
        <section aria-label="Attached note" className="mt-4 rounded-2xl bg-sun/18 p-3">
          <p className="text-[11px] font-extrabold text-ink">The note that came with it</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
            {mirror.data.note.noteUtf8}
          </p>
        </section>
      ) : (
        (!mirrorConfigured || !mirror.connected || mirror.error !== null) && (
          <div className="mt-4">
            <MirrorNotice />
          </div>
        )
      )}

      {deployment.writesEnabled &&
        deployment.chainId === target.chainId &&
        deployment.vaultAddress === target.vault &&
        gift.data.status === 1 && (
          <ClaimFace
            deployment={deployment}
            entrance="load"
            giftId={target.giftId}
            onClaim={() => void gift.refetch()}
          />
        )}
      <BackLink />
    </Shell>
  );
}
