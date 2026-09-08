"use client";

import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import type { Address, Hash } from "viem";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { mapFlowError } from "@/lib/contracts/errors";
import type { AppDeployment } from "@/lib/contracts/config";
import { ReceiptProofError } from "@/lib/contracts/receipts";
import { stocks } from "@/lib/stocks";

export function shortAddress(address: Address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function transactionLink(deployment: AppDeployment, hash: Hash) {
  if (deployment.chainId === 8453) return `https://basescan.org/tx/${hash}`;
  if (deployment.chainId === 84532) return `https://sepolia.basescan.org/tx/${hash}`;
  return null;
}

export function friendlyError(error: unknown) {
  if (error instanceof ReceiptProofError) {
    return "The transaction was mined, but its vault proof did not match. Check the explorer before retrying.";
  }
  return mapFlowError(error).message;
}

export function Spinner() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      aria-hidden="true"
      className="size-4 rounded-full border-2 border-current border-r-transparent"
      animate={reduceMotion ? undefined : { rotate: 360 }}
      transition={reduceMotion ? undefined : { duration: 0.8, ease: "linear", repeat: Infinity }}
    />
  );
}

export function ProgressNotice({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 rounded-xl bg-sky/10 px-3 py-2 text-[12px] font-extrabold text-sky-deep"
    >
      <Spinner />
      {label}
    </motion.div>
  );
}

export function StockDot({ symbol }: { symbol: string }) {
  const stock = stocks.find((candidate) => candidate.symbol === symbol);
  if (stock) {
    return (
      <Image
        src={`/stocks/${stock.symbol}.png`}
        alt=""
        width={32}
        height={32}
        unoptimized
        draggable={false}
        className="size-8 shrink-0 rounded-full bg-white object-contain shadow-sm"
      />
    );
  }
  return (
    <span
      className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-soft text-[11px] font-black text-white shadow-sm"
      aria-hidden="true"
    >
      {symbol[0]}
    </span>
  );
}

export function MirrorNotice({ lagBlocks }: { lagBlocks?: number | null }) {
  const lagging = lagBlocks !== null && lagBlocks !== undefined && lagBlocks > 0;
  return (
    <p
      data-testid="mirror-notice"
      className="flex items-start gap-2 rounded-xl border border-ink/8 bg-cream-deep/55 px-3 py-1.5 text-[10px] leading-snug text-ink-soft"
    >
      <span aria-hidden="true">🌾</span>
      <span>
        {lagging
          ? `Saved history is ${lagBlocks} blocks behind Base. The vault is read directly, so readiness stays exact.`
          : "Saved history and notes are off in this environment. Everything below is read directly from the vault on Base."}
      </span>
    </p>
  );
}

export function ConnectorPicker({ enabled }: { enabled: boolean }) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  if (!enabled || connection.isConnected) return null;
  return (
    <div
      role="group"
      aria-label="Choose a wallet"
      data-testid="connector-picker"
      className="flex flex-wrap items-center gap-2"
    >
      <span className="field-label text-[11px]">Wallet</span>
      {connect.error && (
        <p role="alert" className="text-[12px] text-poppy">
          {friendlyError(connect.error)}
        </p>
      )}
      {connectors.map((connector) => (
        <button
          key={connector.uid}
          type="button"
          onClick={() => connect.mutate({ connector })}
          disabled={connect.isPending}
          className="chip"
        >
          {connector.name}
        </button>
      ))}
    </div>
  );
}
