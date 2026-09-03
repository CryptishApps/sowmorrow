import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { GiftDetail } from "@/components/gift-detail";
import { giftRoutePath, parseGiftRoute } from "@/lib/contracts/gift-link";

type Params = Promise<{ chainId: string; vault: string; giftId: string }>;

const title = "A planted gift — Sowmorrow";
const description = "Read the onchain state of one Sowmorrow gift on Base.";

export async function generateMetadata(
  { params }: { params: Params },
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const target = parseGiftRoute(await params);
  if (target === null) notFound();
  const url = giftRoutePath(target.chainId, target.vault, target.giftId);
  const parentMetadata = await parent;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: "Sowmorrow",
      locale: "en_US",
      type: "website",
      images: parentMetadata.openGraph?.images ?? [],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: parentMetadata.twitter?.images ?? [],
    },
  };
}

export default async function GiftPage({ params }: { params: Params }) {
  const target = parseGiftRoute(await params);
  if (target === null) notFound();
  return <GiftDetail target={target} />;
}
