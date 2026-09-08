import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

function connectionSources() {
  const sources = new Set([
    "'self'",
    "https://mainnet.base.org",
    "https://sepolia.base.org",
    "https://ethereum.reth.rs",
    "https://11155111.rpc.thirdweb.com",
    "https://keys.coinbase.com",
    "https://rpc.wallet.coinbase.com",
    "https://www.walletlink.org",
    "wss://www.walletlink.org",
    "https://cca-lite.coinbase.com",
    "https://as.coinbase.com",
  ]);
  const urls = [
    process.env.NEXT_PUBLIC_BASE_RPC_URL,
    process.env.NEXT_PUBLIC_BASE_RPC_URL_SECONDARY,
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
    process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL_SECONDARY,
    process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL,
    process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL,
    process.env.NEXT_PUBLIC_CONVEX_URL,
    process.env.NEXT_PUBLIC_ANVIL_RPC_URL,
  ];
  for (const value of urls) {
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("Unsupported browser RPC protocol");
    sources.add(url.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    sources.add(url.origin);
  }
  if (process.env.NODE_ENV === "development") {
    sources.add("ws://localhost:3000");
    sources.add("ws://127.0.0.1:3000");
  }
  return [...sources].join(" ");
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectionSources()}`,
    "frame-src https://keys.coinbase.com https://www.walletlink.org",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/", "/gift/:path*", "/testnet", "/((?!_next|.*\\.).*)"],
};
