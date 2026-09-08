import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";

afterEach(() => vi.unstubAllEnvs());

it("permits configured ENS RPC and Convex websocket origins without exposing URL credentials", () => {
  vi.stubEnv("NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL", "https://ens.example/rpc?key=example");
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://mirror.example");
  const response = proxy(new NextRequest("https://www.sowmorrow.app/"));
  const policy = response.headers.get("content-security-policy")!;
  expect(policy).toContain("https://ens.example");
  expect(policy).toContain("wss://mirror.example");
  expect(policy).not.toContain("key=example");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
