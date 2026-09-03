import type { Metadata } from "next";
import { Fraunces, JetBrains_Mono, Nunito } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const siteName = "Sowmorrow";
const title = "Sowmorrow — plant a stock for someone's tomorrow";
const description =
  "Gift a Coinbase tokenized stock on Base. Plant it now, then let the recipient claim it on the date you choose.";
const metadataOrigin =
  process.env.SOWMORROW_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(metadataOrigin),
  title,
  description,
  applicationName: siteName,
  alternates: { canonical: "/" },
  openGraph: {
    title,
    description,
    url: "/",
    siteName,
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${nunito.variable} ${jetbrains.variable} h-full`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
