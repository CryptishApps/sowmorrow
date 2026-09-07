"use client";

import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useConnection,
  useConfig,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { getConnection } from "wagmi/actions";
import { formatUnits, isAddress, getAddress } from "viem";
import type { Address, Hash } from "viem";
import { mainnet } from "viem/chains";
import { ClaimFace } from "@/components/claim-inbox";
import {
  entranceEase,
  entranceItem,
  plantEntrance,
  stockGroup,
  useEntranceSettled,
} from "@/components/entrance";
import type { Entrance } from "@/components/entrance";
import {
  ConnectorPicker,
  friendlyError,
  MirrorNotice,
  ProgressNotice,
  shortAddress,
  Spinner,
  transactionLink,
} from "@/components/gift-chrome";
import { StockRail } from "@/components/stock-rail";
import type { AppDeployment } from "@/lib/contracts/config";
import { GiftFlowError, executePreparedPlant, preparePlant } from "@/lib/contracts/flows";
import type { PlantGateway, PlantPhase, PreparedPlantIntent } from "@/lib/contracts/flows";
import { ib20Abi, ib20AssetAbi, sowmorrowVaultAbi } from "@/lib/contracts/generated";
import { decodePendingGift, encodePendingGift, pendingPlantStorageKey } from "@/lib/contracts/pending";
import type { PendingGiftSubmission, PendingPlantSubmission } from "@/lib/contracts/pending";
import { proveGiftCreated, ReceiptProofError } from "@/lib/contracts/receipts";
import { mirrorApi, mirrorConfigured } from "@/lib/convex/api";
import { useMirrorMutation, useMirrorQuery } from "@/lib/convex/provider";
import {
  daysUntil,
  formatUnlockReview,
  hashGiftNote,
  isGiftNoteValid,
  MAX_GIFT_NOTE_BYTES,
  minimumUnlockDate,
  noteByteLength,
  resolveRecipient,
  toUnlockAt,
} from "@/lib/gifts";
import { readReceiptWithFallback, secondaryPublicClient } from "@/lib/web3/secondary";
import { transactionDataSuffix } from "@/lib/web3/attribution";
import { stocks } from "@/lib/stocks";
import type { StockSymbol } from "@/lib/stocks";

export type Face = "plant" | "claim";

type Props = {
  face: Face;
  deployment: AppDeployment;
  onFaceChange: (face: Face) => void;
  onPlant: () => void;
  onClaim: () => void;
};

type FaceProps = {
  deployment: AppDeployment;
  entrance: Entrance;
};

type NoteAttachment = "idle" | "pending" | "attached" | "failed";

const faceLabels: Record<Face, string> = { plant: "Plant", claim: "Claim" };

const plantPhaseLabels: Record<PlantPhase, string> = {
  resolving_recipient: "Resolving recipient",
  quoting_amount: "Checking stock balance",
  revalidating_review: "Rechecking your review",
  awaiting_approval: "Approve the exact amount",
  confirming_approval: "Approval is settling",
  awaiting_plant: "Confirm the gift",
  confirming_plant: "Planting on Base",
  success: "Gift planted",
};

function readPendingGift(key: string | null) {
  if (!key || typeof window === "undefined") return null;
  try {
    const pending = decodePendingGift(window.localStorage.getItem(key) ?? "");
    if (pending?.kind === "gift" && pending.note && Date.now() / 1_000 - pending.submittedAt > 86_400) {
      const expired = { ...pending, note: undefined };
      writePendingGift(key, expired);
      return expired;
    }
    return pending;
  } catch {
    return null;
  }
}

function writePendingGift(key: string | null, gift: PendingPlantSubmission | null) {
  if (!key || typeof window === "undefined") return;
  try {
    if (gift) window.localStorage.setItem(key, encodePendingGift(gift));
    else window.localStorage.removeItem(key);
  } catch {}
}

function FaceTabs({ face, onFaceChange }: Pick<Props, "face" | "onFaceChange">) {
  const chooseAdjacent = (event: React.KeyboardEvent, option: Face) => {
    let next: Face | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      next = option === "plant" ? "claim" : "plant";
    } else if (event.key === "Home") {
      next = "plant";
    } else if (event.key === "End") {
      next = "claim";
    }
    if (!next) return;
    event.preventDefault();
    onFaceChange(next);
    document.getElementById(`${next}-tab`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Gift actions"
      className="relative flex rounded-full bg-ink/8 p-1 text-[13px] font-bold"
    >
      {(["plant", "claim"] as const).map((option) => (
        <button
          key={option}
          role="tab"
          type="button"
          id={`${option}-tab`}
          aria-controls={`${option}-panel`}
          aria-selected={face === option}
          tabIndex={face === option ? 0 : -1}
          onKeyDown={(event) => chooseAdjacent(event, option)}
          onClick={() => onFaceChange(option)}
          className="relative z-10 rounded-full px-3.5 py-1.5 text-ink transition-colors aria-selected:text-cream focus-visible:outline-3 focus-visible:outline-meadow/50"
        >
          {face === option && (
            <motion.span
              layoutId="face-tab"
              className="absolute inset-0 -z-10 rounded-full bg-ink"
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            />
          )}
          {faceLabels[option]}
        </button>
      ))}
    </div>
  );
}

function NetworkBadge({ deployment }: { deployment: AppDeployment }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-meadow/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-meadow-deep">
      <span className="size-1.5 rounded-full bg-meadow" aria-hidden="true" />
      {deployment.networkName}
      {!deployment.writesEnabled && " preview"}
    </span>
  );
}

function WalletLine() {
  const connection = useConnection();
  const disconnect = useDisconnect();
  if (!connection.address) return null;
  return (
    <button
      type="button"
      onClick={() => disconnect.mutate()}
      className="font-mono text-[10px] font-bold text-ink-soft underline decoration-ink/20 underline-offset-2 hover:text-ink"
    >
      {shortAddress(connection.address)} · disconnect
    </button>
  );
}

const PlantFace = forwardRef<HTMLInputElement, FaceProps & Pick<Props, "onPlant">>(function PlantFace(
  { deployment, entrance, onPlant },
  recipientRef,
) {
  const availableSymbols = useMemo(
    () => new Set(Object.keys(deployment.stockAddresses) as StockSymbol[]),
    [deployment.stockAddresses],
  );
  const firstAvailable =
    stocks.find((stock) => availableSymbols.has(stock.symbol))?.symbol ?? stocks[0].symbol;
  const [symbol, setSymbol] = useState<StockSymbol>(firstAvailable);
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<PlantPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<PreparedPlantIntent | null>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const [contractAcknowledged, setContractAcknowledged] = useState(false);
  const [pendingGift, setPendingGift] = useState<PendingPlantSubmission | null>(null);
  const reviewGeneration = useRef(0);
  const [success, setSuccess] = useState<{
    hash: Hash;
    giftId: bigint | null;
    recipient: Address;
    amount: string;
    symbol: StockSymbol;
    note: string;
  } | null>(null);
  const [noteAttachment, setNoteAttachment] = useState<NoteAttachment>("idle");
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [minDate] = useState(() => minimumUnlockDate());
  const [minGiftAmountLabel, setMinGiftAmountLabel] = useState<string | null>(null);

  const connection = useConnection();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const config = useConfig();
  const client = usePublicClient({ chainId: deployment.chainId });
  const ensClient = usePublicClient({ chainId: mainnet.id });
  const reduceMotion = useReducedMotion();
  const entranceState = useEntranceSettled(reduceMotion);
  const attachNote = useMirrorMutation(mirrorApi.attachNote);
  const indexedNoteGift = useMirrorQuery(
    mirrorApi.giftDetail,
    success && success.giftId !== null && success.note.length > 0 && deployment.vaultAddress
      ? {
          chainId: deployment.chainId,
          vault: deployment.vaultAddress,
          giftId: success.giftId.toString(),
        }
      : null,
  );
  const storageKey =
    deployment.vaultAddress && connection.address
      ? pendingPlantStorageKey(deployment.chainId, deployment.vaultAddress, connection.address)
      : null;

  const unlockAt = toUnlockAt(date);
  const days = daysUntil(date);
  const noteBytes = noteByteLength(note);
  const stockAddress = deployment.stockAddresses[symbol];
  const busy = phase !== null && phase !== "success";
  const reviewing = intent !== null;
  const contractWarningUnmet = intent !== null && intent.recipientIsContract && !contractAcknowledged;
  const formComplete =
    recipientInput.trim().length > 0 &&
    amountInput.length > 0 &&
    unlockAt !== null &&
    stockAddress !== undefined &&
    isGiftNoteValid(note);

  useEffect(() => {
    if (!intent) return;
    reviewRef.current?.focus({ preventScroll: true });
    reviewRef.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [intent]);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => {
      const persisted = readPendingGift(storageKey);
      if (!current) return;
      if (persisted?.kind === "gift" && persisted.giftId !== undefined) {
        const noteText =
          Date.now() / 1_000 - persisted.submittedAt <= 86_400
            ? persisted.note && hashGiftNote(persisted.note) === persisted.noteHash
              ? persisted.note
              : ""
            : "";
        setSuccess({
          hash: persisted.hash,
          giftId: persisted.giftId,
          recipient: persisted.recipient,
          amount: persisted.transferableAmount,
          symbol: persisted.symbol,
          note: noteText,
        });
        setPhase("success");
        setPendingGift(null);
        if (!noteText) writePendingGift(storageKey, null);
      } else {
        setPendingGift(persisted);
      }
    });
    return () => {
      current = false;
    };
  }, [storageKey]);

  useEffect(() => {
    const vaultAddress = deployment.vaultAddress;
    let current = true;
    void (async () => {
      if (!client || !vaultAddress || !stockAddress) {
        if (current) setMinGiftAmountLabel(null);
        return;
      }
      try {
        const [minAmountRaw, decimals] = await Promise.all([
          client.readContract({
            address: vaultAddress,
            abi: sowmorrowVaultAbi,
            functionName: "minGiftAmountRaw",
            args: [stockAddress],
          }),
          client.readContract({ address: stockAddress, abi: ib20Abi, functionName: "decimals" }),
        ]);
        const minAmountScaled = await client.readContract({
          address: stockAddress,
          abi: ib20AssetAbi,
          functionName: "toScaledBalance",
          args: [minAmountRaw],
        });
        if (current) setMinGiftAmountLabel(formatUnits(minAmountScaled, decimals));
      } catch {
        if (current) setMinGiftAmountLabel(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, deployment.vaultAddress, stockAddress]);

  const invalidateReview = () => {
    reviewGeneration.current += 1;
    setIntent(null);
    setContractAcknowledged(false);
  };

  const saveNote = useCallback(
    async (giftId: bigint, noteText: string) => {
      const vaultAddress = deployment.vaultAddress;
      if (!indexedNoteGift.connected || !vaultAddress || noteText.length === 0) return;
      setNoteAttachment("pending");
      try {
        await attachNote({
          chainId: deployment.chainId,
          vault: vaultAddress,
          giftId: giftId.toString(),
          note: noteText,
        });
        setNoteAttachment("attached");
        const persisted = readPendingGift(storageKey);
        if (persisted?.kind === "gift" && persisted.giftId === giftId && persisted.note === noteText)
          writePendingGift(storageKey, null);
      } catch {
        setNoteAttachment("failed");
      }
    },
    [attachNote, deployment.chainId, deployment.vaultAddress, indexedNoteGift.connected, storageKey],
  );

  useEffect(() => {
    if (
      !success ||
      success.giftId === null ||
      success.note.length === 0 ||
      noteAttachment !== "idle" ||
      indexedNoteGift.data === undefined ||
      indexedNoteGift.data === null
    ) {
      return;
    }
    const giftId = success.giftId;
    const noteText = success.note;
    queueMicrotask(() => void saveNote(giftId, noteText));
  }, [indexedNoteGift.data, noteAttachment, saveNote, success]);

  const makeGateway = (): PlantGateway | null => {
    const vaultAddress = deployment.vaultAddress;
    const account = connection.address;
    if (!account || !client || !ensClient || !vaultAddress) return null;
    const assertAccount = () => {
      const current = getConnection(config);
      if (
        current.address?.toLowerCase() !== account.toLowerCase() ||
        current.chainId !== deployment.chainId
      ) {
        throw new GiftFlowError("review_changed");
      }
    };
    return {
      resolveRecipient: (input) => resolveRecipient(input, ensClient),
      getBlockSnapshot: async () => {
        const block = await client.getBlock({ blockTag: "latest" });
        if (block.number === null) throw new Error("Latest Base block has no number");
        return { number: block.number, timestamp: block.timestamp };
      },
      getVaultVersion: async (vault, blockNumber) =>
        client.readContract({
          address: vault,
          abi: sowmorrowVaultAbi,
          functionName: "VERSION",
          blockNumber,
        }),
      getDecimals: async (stock, blockNumber) =>
        client.readContract({ address: stock, abi: ib20Abi, functionName: "decimals", blockNumber }),
      toRawBalance: async (stock, amountScaled, blockNumber) =>
        client.readContract({
          address: stock,
          abi: ib20AssetAbi,
          functionName: "toRawBalance",
          args: [amountScaled],
          blockNumber,
        }),
      toScaledBalance: async (stock, amountRaw, blockNumber) =>
        client.readContract({
          address: stock,
          abi: ib20AssetAbi,
          functionName: "toScaledBalance",
          args: [amountRaw],
          blockNumber,
        }),
      getRawBalance: async (stock, holder, blockNumber) =>
        client.readContract({
          address: stock,
          abi: ib20Abi,
          functionName: "balanceOf",
          args: [holder],
          blockNumber,
        }),
      getAllowance: async (stock, holder, vault, blockNumber) =>
        client.readContract({
          address: stock,
          abi: ib20Abi,
          functionName: "allowance",
          args: [holder, vault],
          blockNumber,
        }),
      isStockSupported: async (stock, vault, blockNumber) =>
        client.readContract({
          address: vault,
          abi: sowmorrowVaultAbi,
          functionName: "supportedStock",
          args: [stock],
          blockNumber,
        }),
      getMinGiftAmountRaw: async (stock, vault, blockNumber) =>
        client.readContract({
          address: vault,
          abi: sowmorrowVaultAbi,
          functionName: "minGiftAmountRaw",
          args: [stock],
          blockNumber,
        }),
      isCreationPaused: async (vault, blockNumber) =>
        client.readContract({
          address: vault,
          abi: sowmorrowVaultAbi,
          functionName: "creationPaused",
          blockNumber,
        }),
      hasContractCode: async (address, blockNumber) => {
        const code = await client.getCode({ address, blockNumber });
        return code !== undefined && code !== "0x";
      },
      approve: async (stock, vault, amountRaw) => {
        await client.simulateContract({
          account,
          address: stock,
          abi: ib20Abi,
          functionName: "approve",
          args: [vault, amountRaw],
        });
        assertAccount();
        return write.mutateAsync({
          dataSuffix: transactionDataSuffix,
          account,
          address: stock,
          abi: ib20Abi,
          functionName: "approve",
          args: [vault, amountRaw],
          chainId: deployment.chainId,
        });
      },
      createGift: async (stock, recipient, amountRaw, giftUnlockAt, noteHash) => {
        await client.simulateContract({
          account,
          address: vaultAddress,
          abi: sowmorrowVaultAbi,
          functionName: "createGift",
          args: [stock, recipient, amountRaw, giftUnlockAt, noteHash],
        });
        assertAccount();
        return write.mutateAsync({
          dataSuffix: transactionDataSuffix,
          account,
          address: vaultAddress,
          abi: sowmorrowVaultAbi,
          functionName: "createGift",
          args: [stock, recipient, amountRaw, giftUnlockAt, noteHash],
          chainId: deployment.chainId,
        });
      },
      waitForApprovalReceipt: async (hash) => {
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new ReceiptProofError("receipt_reverted");
      },
      waitForGiftReceipt: async (hash, expected) => {
        const receipt = await client.waitForTransactionReceipt({ hash });
        return proveGiftCreated(receipt, expected);
      },
    };
  };

  const prepareReview = async () => {
    const vaultAddress = deployment.vaultAddress;
    const account = connection.address;
    const gateway = makeGateway();
    if (!gateway || !account || !vaultAddress || !stockAddress || unlockAt === null) return;
    const generation = reviewGeneration.current + 1;
    reviewGeneration.current = generation;
    setError(null);
    setRecoveryNotice(null);
    setSuccess(null);
    setContractAcknowledged(false);

    try {
      const prepared = await preparePlant(
        gateway,
        {
          account,
          stock: stockAddress,
          vault: vaultAddress,
          recipientInput,
          amountInput,
          unlockAt,
          noteHash: hashGiftNote(note),
        },
        setPhase,
      );
      if (reviewGeneration.current === generation) setIntent(prepared);
      setPhase(null);
    } catch (caught) {
      if (reviewGeneration.current === generation) {
        setPhase(null);
        setError(friendlyError(caught));
      }
    }
  };

  const submitIntent = async (reviewed: PreparedPlantIntent) => {
    const gateway = makeGateway();
    const account = connection.address;
    if (!gateway || !account || connection.chainId !== deployment.chainId) return;
    if (account.toLowerCase() !== reviewed.account.toLowerCase()) {
      invalidateReview();
      setError("The connected account changed. Review the gift again before signing.");
      return;
    }

    setError(null);
    setRecoveryNotice(null);
    setSuccess(null);
    setNoteAttachment("idle");
    let submittedGift: PendingGiftSubmission | null = null;
    let submittedKind: "approval" | "gift" | null = null;
    try {
      const result = await executePreparedPlant(gateway, reviewed, setPhase, (transaction) => {
        submittedKind = transaction.kind;
        if (transaction.kind === "approval") {
          const pendingApproval: PendingPlantSubmission = {
            version: 1,
            kind: "approval",
            chainId: deployment.chainId,
            hash: transaction.hash,
            vault: reviewed.vault,
            account: reviewed.account,
            stock: reviewed.stock,
            amountRaw: reviewed.amountRaw,
            symbol,
            submittedAt: Math.floor(Date.now() / 1_000),
          };
          setPendingGift(pendingApproval);
          writePendingGift(storageKey, pendingApproval);
          return;
        }
        submittedGift = {
          version: 1,
          kind: "gift",
          chainId: deployment.chainId,
          hash: transaction.hash,
          vault: reviewed.vault,
          account: reviewed.account,
          recipient: reviewed.recipient,
          stock: reviewed.stock,
          amountRaw: reviewed.amountRaw,
          unlockAt: reviewed.unlockAt,
          noteHash: reviewed.noteHash,
          note,
          amountInput: reviewed.amountInput,
          transferableAmount: formatUnits(reviewed.transferableAmountScaled, reviewed.decimals),
          symbol,
          submittedAt: Math.floor(Date.now() / 1_000),
        };
        setPendingGift(submittedGift);
        writePendingGift(storageKey, submittedGift);
      });
      const confirmed = readPendingGift(storageKey);
      writePendingGift(
        storageKey,
        confirmed?.kind === "gift" && confirmed.note ? { ...confirmed, giftId: result.giftId } : null,
      );
      setPendingGift(null);
      setIntent(null);
      setSuccess({
        hash: result.giftHash,
        giftId: result.giftId,
        recipient: result.recipient,
        amount: formatUnits(reviewed.transferableAmountScaled, reviewed.decimals),
        symbol,
        note,
      });
      onPlant();
    } catch (caught) {
      setPhase(null);
      if (
        caught instanceof GiftFlowError &&
        (caught.code === "review_changed" || caught.code === "unlock_too_soon")
      ) {
        invalidateReview();
      }
      setError(
        submittedGift
          ? "The gift was submitted, but confirmation is not known. Do not submit it again until you check this transaction."
          : submittedKind === "approval"
            ? "The approval was submitted, but confirmation is not known. Check it before asking your wallet to approve again."
            : friendlyError(caught),
      );
    }
  };

  const recoverPendingGift = async () => {
    if (!client || !pendingGift || !deployment.vaultAddress) return;
    setPhase(pendingGift.kind === "gift" ? "confirming_plant" : "confirming_approval");
    setError(null);
    setRecoveryNotice(null);
    try {
      const receipt = await readReceiptWithFallback(
        [client, secondaryPublicClient(deployment.chainId)],
        pendingGift.hash,
      );
      if (pendingGift.kind === "approval") {
        if (receipt.status !== "success") throw new ReceiptProofError("receipt_reverted");
        const allowance = await client.readContract({
          address: pendingGift.stock,
          abi: ib20Abi,
          functionName: "allowance",
          args: [pendingGift.account, pendingGift.vault],
        });
        if (allowance < pendingGift.amountRaw) throw new GiftFlowError("approval_not_confirmed");
        writePendingGift(storageKey, null);
        setPendingGift(null);
        setPhase(null);
        setRecoveryNotice("Approval confirmed. Review the exact gift again before planting it.");
        return;
      }
      const proof = proveGiftCreated(receipt, {
        vault: pendingGift.vault,
        sender: pendingGift.account,
        recipient: pendingGift.recipient,
        stock: pendingGift.stock,
        amountRaw: pendingGift.amountRaw,
        unlockAt: pendingGift.unlockAt,
        noteHash: pendingGift.noteHash,
      });
      const recoveredNote =
        Date.now() / 1_000 - pendingGift.submittedAt <= 86_400
          ? pendingGift.note && hashGiftNote(pendingGift.note) === pendingGift.noteHash
            ? pendingGift.note
            : ""
          : "";
      writePendingGift(storageKey, recoveredNote ? { ...pendingGift, giftId: proof.giftId } : null);
      setPendingGift(null);
      setPhase("success");
      setSuccess({
        hash: pendingGift.hash,
        giftId: proof.giftId,
        recipient: pendingGift.recipient,
        amount: pendingGift.transferableAmount,
        symbol: pendingGift.symbol,
        note: recoveredNote,
      });
      onPlant();
    } catch (caught) {
      setPhase(null);
      if (
        (caught instanceof ReceiptProofError && caught.code === "receipt_reverted") ||
        (pendingGift.kind === "approval" &&
          caught instanceof GiftFlowError &&
          caught.code === "approval_not_confirmed")
      ) {
        writePendingGift(storageKey, null);
        setPendingGift(null);
        setError(
          pendingGift.kind === "gift"
            ? "The submitted gift reverted. It is safe to review and submit a new transaction."
            : "The submitted approval reverted. It is safe to review and approve again.",
        );
      } else {
        setError(
          "The submitted transaction is not confirmed yet, or its proof could not be read. Do not submit another gift; check again or inspect it on the explorer.",
        );
      }
    }
  };

  if (success) {
    const explorer = transactionLink(deployment, success.hash);
    const detailLink =
      deployment.vaultAddress && success.giftId !== null
        ? `/gift/${deployment.chainId}/${deployment.vaultAddress}/${success.giftId}`
        : null;
    return (
      <motion.section
        id="plant-panel"
        role="tabpanel"
        aria-label="Plant"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex min-h-[380px] flex-1 flex-col justify-between gap-5 px-4 pb-4 pt-4 text-left sm:min-h-0 sm:px-5 sm:pb-5 sm:pt-6"
      >
        <div>
          <motion.div
            initial={reduceMotion ? false : { scale: 0.6, rotate: -12 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            className="mb-4 grid size-12 place-items-center rounded-full bg-meadow-deep text-xl text-cream"
            aria-hidden="true"
          >
            ✓
          </motion.div>
          <p className="display text-[30px] leading-tight text-ink">It&rsquo;s in the ground.</p>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
            {success.amount} {success.symbol} is locked for {shortAddress(success.recipient)} until the chosen
            day.
          </p>
          {success.note.length > 0 && (
            <p className="mt-3 rounded-xl bg-sun/18 px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
              Public note: anyone can read this text. An unsaved copy stays in this browser until saved or
              discarded. Recovery expires after 24 hours; expired text is removed when you return. Do not
              include private information.
            </p>
          )}
          {success.note.length > 0 && noteAttachment === "idle" && (
            <p role="status" className="mt-2 text-[11px] font-extrabold text-meadow-deep">
              Saving the note once the gift appears in history…
            </p>
          )}
          {success.note.length > 0 && noteAttachment === "pending" && (
            <p role="status" className="mt-2 text-[11px] font-extrabold text-meadow-deep">
              Saving the note…
            </p>
          )}
          {success.note.length > 0 && noteAttachment === "attached" && (
            <p role="status" className="mt-2 text-[11px] font-extrabold text-meadow-deep">
              The public note is saved.
            </p>
          )}
          {success.note.length > 0 && noteAttachment === "failed" && (
            <p className="mt-2 text-[11px] text-ink-soft">
              The gift is planted. Saving the note text failed.{" "}
              <button
                type="button"
                onClick={() => success.giftId !== null && void saveNote(success.giftId, success.note)}
                className="font-extrabold text-sky-deep underline underline-offset-2"
              >
                Save the note again
              </button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setPhase(null);
              setSuccess(null);
              setNoteAttachment("idle");
              setAmountInput("");
              setDate("");
              setNote("");
            }}
            disabled={success.note.length > 0 && noteAttachment !== "attached"}
            className="primary-button"
          >
            Plant another
          </button>
          {success.note.length > 0 && noteAttachment !== "attached" && (
            <button
              type="button"
              className="text-[12px] underline"
              onClick={() => {
                writePendingGift(storageKey, null);
                setSuccess({ ...success, note: "" });
              }}
            >
              Discard unsaved note
            </button>
          )}
          {detailLink && (
            <a
              href={detailLink}
              className="text-[12px] font-extrabold text-sky-deep underline underline-offset-2"
            >
              Open the gift page
            </a>
          )}
          {explorer && (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-extrabold text-sky-deep underline underline-offset-2"
            >
              View transaction
            </a>
          )}
        </div>
      </motion.section>
    );
  }

  const primaryAction = () => {
    if (!connection.isConnected) {
      document.querySelector<HTMLButtonElement>('[data-testid="connector-picker"] button')?.focus();
      return;
    }
    if (connection.chainId !== deployment.chainId) {
      switchChain.mutate({ chainId: deployment.chainId });
      return;
    }
    if (pendingGift) return;
    if (intent) void submitIntent(intent);
    else void prepareReview();
  };

  const buttonLabel = !deployment.writesEnabled
    ? "Vault deployment pending"
    : !connection.isConnected
      ? "Connect wallet"
      : connection.chainId !== deployment.chainId
        ? `Switch to ${deployment.networkName}`
        : pendingGift
          ? "Confirmation required"
          : intent
            ? "Confirm and plant"
            : "Review gift";
  const reviewedUnlock = intent ? formatUnlockReview(intent.unlockAt) : null;
  const reviewedAmount = intent ? formatUnits(intent.transferableAmountScaled, intent.decimals) : null;
  const reviewedRecipient = intent
    ? isAddress(intent.recipientInput.trim())
      ? getAddress(intent.recipient)
      : `${intent.recipientInput} · ${getAddress(intent.recipient)}`
    : null;
  const selectedStock = stocks.find((stock) => stock.symbol === symbol) ?? stocks[0];
  const pendingExplorer = pendingGift ? transactionLink(deployment, pendingGift.hash) : null;

  return (
    <section id="plant-panel" role="tabpanel" aria-label="Plant" className="flex min-h-0 flex-1 flex-col">
      <motion.form
        variants={plantEntrance(entrance)}
        initial={reduceMotion ? false : "hidden"}
        animate="show"
        onAnimationComplete={entranceState.settle}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 px-4 pb-4 pt-3 text-left sm:gap-2 sm:px-5 sm:pb-5 sm:pt-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          primaryAction();
        }}
      >
        <div
          data-testid="plant-scroll-region"
          className={`scroll-region -mx-1.5 flex min-h-0 flex-1 flex-col gap-2.5 px-1.5 sm:gap-1.5 sm:overscroll-contain ${entranceState.scrollable ? "sm:overflow-y-auto" : "sm:overflow-hidden"}`}
        >
          <motion.label variants={entranceItem} className="flex flex-col gap-1">
            <span className="field-label">Who is it for</span>
            <input
              ref={recipientRef}
              className="field"
              placeholder="name.base.eth or 0x…"
              autoComplete="off"
              spellCheck={false}
              value={recipientInput}
              onChange={(event) => {
                invalidateReview();
                setRecipientInput(event.target.value);
              }}
              disabled={busy || reviewing || pendingGift !== null}
            />
          </motion.label>

          <motion.fieldset variants={stockGroup} className="flex min-w-0 flex-col gap-1">
            <motion.legend variants={entranceItem} className="field-label mb-0.5">
              Which stock
            </motion.legend>
            <StockRail
              selected={symbol}
              onSelect={(nextSymbol) => {
                invalidateReview();
                setSymbol(nextSymbol);
              }}
              availableSymbols={availableSymbols}
              disabled={busy || reviewing || pendingGift !== null}
            />
          </motion.fieldset>

          <motion.div variants={entranceItem} className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="field-label">How much</span>
              <div className="relative">
                <input
                  className="field pr-16"
                  inputMode="decimal"
                  placeholder="0.10"
                  value={amountInput}
                  onChange={(event) => {
                    invalidateReview();
                    setAmountInput(event.target.value);
                  }}
                  disabled={busy || reviewing || pendingGift !== null}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3.5 grid place-items-center text-[11px] font-black text-ink-soft">
                  {symbol}
                </span>
              </div>
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="field-label">Opens on</span>
              <input
                className="field"
                type="date"
                min={minDate}
                value={date}
                onChange={(event) => {
                  invalidateReview();
                  setDate(event.target.value);
                }}
                disabled={busy || reviewing || pendingGift !== null}
              />
            </label>
          </motion.div>
          <motion.div variants={entranceItem} className="-mt-1 grid grid-cols-2 gap-3">
            <p className="min-h-4 pl-3.5 font-mono text-[10px] text-ink-soft">
              {minGiftAmountLabel !== null ? `Minimum ${minGiftAmountLabel} ${symbol}` : " "}
            </p>
            <p className="min-h-4 pl-3.5 font-mono text-[10px] text-ink-soft">
              {unlockAt !== null && days !== null
                ? `${days} day${days === 1 ? "" : "s"} away · 09:00 in your current time zone`
                : "Opens at 09:00 on the day you pick."}
            </p>
          </motion.div>

          <motion.label variants={entranceItem} className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-3">
              <span className="field-label">
                Gift note <span className="font-semibold text-ink-soft">(optional)</span>
              </span>
              <span
                className={`font-mono text-[10px] ${noteBytes > MAX_GIFT_NOTE_BYTES ? "text-[#9f2e18]" : "text-ink-soft"}`}
              >
                {noteBytes}/{MAX_GIFT_NOTE_BYTES} bytes
              </span>
            </span>
            <textarea
              className="field min-h-12 resize-none"
              placeholder="A public note — never include private information"
              value={note}
              onChange={(event) => {
                invalidateReview();
                setNote(event.target.value);
              }}
              disabled={busy || reviewing || pendingGift !== null}
            />
          </motion.label>
          {intent && reviewedUnlock && reviewedAmount && (
            <motion.section
              ref={reviewRef}
              tabIndex={-1}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              aria-label="Gift review"
              className="rounded-2xl border border-meadow/25 bg-meadow/7 p-3 text-[11px] leading-relaxed text-ink-soft"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-extrabold text-ink">Review your gift</p>
                <button
                  type="button"
                  onClick={invalidateReview}
                  disabled={busy}
                  className="font-extrabold text-sky-deep underline underline-offset-2"
                >
                  Edit
                </button>
              </div>
              <dl className="mt-2 grid gap-1.5">
                <div>
                  <dt className="font-extrabold text-ink">Recipient</dt>
                  <dd className="break-all font-mono">{reviewedRecipient}</dd>
                </div>
                <div>
                  <dt className="font-extrabold text-ink">Stock and amount</dt>
                  <dd>
                    {selectedStock.name} · {reviewedAmount} {symbol}
                    {reviewedAmount !== intent.amountInput && ` (entered ${intent.amountInput})`}
                  </dd>
                </div>
                <div>
                  <dt className="font-extrabold text-ink">Opens</dt>
                  <dd>{reviewedUnlock.localDate}</dd>
                </div>
                {note.length > 0 && (
                  <div>
                    <dt className="font-extrabold text-ink">Note</dt>
                    <dd className="whitespace-pre-wrap break-words">{note}</dd>
                    <dd>
                      Public note: anyone can read this text. An unsaved copy stays in this browser until
                      saved or discarded. Recovery expires after 24 hours; expired text is removed when you
                      return. Do not include private information.
                    </dd>
                  </div>
                )}
              </dl>
              {intent.recipientIsContract && (
                <div className="mt-2 rounded-xl border border-sun-deep/40 bg-sun/20 p-2.5 text-ink">
                  <p className="font-extrabold">This address uses a smart contract.</p>
                  <p className="mt-1 font-bold">
                    A contract can only take this gift if it is able to call <code>claim</code> on the vault
                    itself. Exchange deposit addresses and most contracts cannot. Nobody, including Sowmorrow,
                    can move the gift afterwards.
                  </p>
                  <label className="mt-2 flex items-start gap-2 font-extrabold">
                    <input
                      type="checkbox"
                      checked={contractAcknowledged}
                      onChange={(event) => setContractAcknowledged(event.target.checked)}
                      className="mt-0.5 size-4 shrink-0 accent-[#2a6b34] focus-visible:outline-3 focus-visible:outline-meadow/50"
                    />
                    <span>I know this contract can call claim, and I accept the risk.</span>
                  </label>
                </div>
              )}
              <p className="mt-2 font-extrabold text-[#8b4b22]">
                Use a wallet the recipient controls and can claim from, rather than an exchange deposit
                address. This gift cannot be cancelled, reassigned, or recovered by Sowmorrow. Token
                eligibility and issuer policies still apply. Your wallet will estimate gas before signing.
              </p>
            </motion.section>
          )}

          {pendingGift && (
            <section
              aria-label="Submitted gift recovery"
              className="rounded-2xl border border-sun-deep/30 bg-sun/14 p-3 text-[11px] leading-relaxed text-ink-soft"
            >
              <p className="font-extrabold text-ink">
                A {pendingGift.kind === "gift" ? "gift" : "stock approval"} transaction is already submitted.
              </p>
              <p>
                Do not submit {pendingGift.kind === "gift" ? "the gift" : "another approval"} until its
                receipt is known.
              </p>
              <p className="mt-1 break-all font-mono text-[9px] text-ink">{pendingGift.hash}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void recoverPendingGift()}
                  disabled={busy}
                  className="font-extrabold text-sky-deep underline underline-offset-2"
                >
                  Check {pendingGift.kind === "gift" ? "gift" : "approval"}
                </button>
                {pendingExplorer && (
                  <a
                    href={pendingExplorer}
                    target="_blank"
                    rel="noreferrer"
                    className="font-extrabold text-sky-deep underline underline-offset-2"
                  >
                    Open explorer
                  </a>
                )}
              </div>
            </section>
          )}

          {phase && phase !== "success" && <ProgressNotice label={plantPhaseLabels[phase]} />}
          {recoveryNotice && (
            <p
              role="status"
              className="rounded-xl bg-meadow/12 px-3 py-2 text-[12px] font-extrabold text-meadow-deep"
            >
              {recoveryNotice}
            </p>
          )}
          {error && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              role="alert"
              className="rounded-xl bg-poppy/10 px-3 py-2 text-[12px] font-bold text-[#9f2e18]"
            >
              {error}
            </motion.p>
          )}
          {!mirrorConfigured && note.length > 0 && (
            <motion.div variants={entranceItem}>
              <MirrorNotice />
            </motion.div>
          )}
        </div>

        <motion.div variants={entranceItem} className="flex shrink-0 flex-col gap-2">
          <ConnectorPicker enabled={deployment.writesEnabled} />
          <button
            type="submit"
            disabled={
              busy ||
              pendingGift !== null ||
              !deployment.writesEnabled ||
              contractWarningUnmet ||
              (connection.isConnected &&
                connection.chainId === deployment.chainId &&
                intent === null &&
                !formComplete)
            }
            className="primary-button flex items-center justify-center gap-2"
          >
            {busy && <Spinner />}
            {busy && phase ? plantPhaseLabels[phase] : buttonLabel}
          </button>
        </motion.div>
      </motion.form>
    </section>
  );
});

function AnimatedFace({
  face,
  entrance,
  deployment,
  onPlant,
  onClaim,
  recipientRef,
}: Omit<Props, "onFaceChange"> & {
  entrance: Entrance;
  recipientRef: React.ForwardedRef<HTMLInputElement>;
}) {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const connection = useConnection();
  const identity = `${deployment.chainId}:${deployment.vaultAddress}:${connection.chainId}:${connection.address}`;
  return (
    <motion.div
      aria-hidden={!isPresent}
      inert={!isPresent ? true : undefined}
      initial={reduceMotion || entrance === "load" ? false : { opacity: 0, x: face === "claim" ? 14 : -14 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: face === "claim" ? -14 : 14 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: entranceEase }}
      className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col"
    >
      {face === "plant" ? (
        <PlantFace
          key={identity}
          ref={recipientRef}
          deployment={deployment}
          entrance={entrance}
          onPlant={onPlant}
        />
      ) : (
        <ClaimFace key={identity} deployment={deployment} entrance={entrance} onClaim={onClaim} />
      )}
    </motion.div>
  );
}

export const GiftWidget = forwardRef<HTMLInputElement, Props>(function GiftWidget(
  { face, deployment, onFaceChange, onPlant, onClaim },
  recipientRef,
) {
  const [entrance, setEntrance] = useState<Entrance>("load");
  const changeFace = (next: Face) => {
    setEntrance("switch");
    onFaceChange(next);
  };

  return (
    <div className="flex w-full flex-col overflow-hidden rounded-t-[26px] border-x border-t border-ink/10 bg-cream shadow-card sm:h-[calc(100dvh-11rem)] sm:max-h-[541px]">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex flex-col items-start gap-1">
          <NetworkBadge deployment={deployment} />
          <WalletLine />
          {deployment.chainId === 84532 && (
            <a href="/testnet" className="text-[10px] font-bold text-sky-deep underline">
              Valueless test assets · get test funds
            </a>
          )}
        </div>
        <FaceTabs face={face} onFaceChange={changeFace} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]">
        <AnimatePresence>
          <AnimatedFace
            key={face}
            face={face}
            entrance={entrance}
            deployment={deployment}
            onPlant={onPlant}
            onClaim={onClaim}
            recipientRef={recipientRef}
          />
        </AnimatePresence>
      </div>
    </div>
  );
});
