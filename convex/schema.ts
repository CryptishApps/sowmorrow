import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const canonicality = v.union(v.literal("tip"), v.literal("safe"));
const observedCanonicality = v.union(canonicality, v.literal("orphaned"));

const deliveryFailureCode = v.union(
  v.literal("configuration"),
  v.literal("rpc_failure"),
  v.literal("receipt_failed"),
  v.literal("receipt_mismatch"),
  v.literal("log_missing"),
  v.literal("log_decode_failed"),
  v.literal("event_conflict"),
  v.literal("attempts_exhausted"),
);

const syncPipeline = v.union(
  v.literal("vault-events"),
  v.literal("factory-candidates"),
  v.literal("solvency-monitor"),
  v.literal("operator-repair"),
);

const syncOutcome = v.union(
  v.literal("indexed"),
  v.literal("caught_up"),
  v.literal("promoted_tip_events"),
  v.literal("rewound"),
  v.literal("halted"),
  v.literal("not_configured"),
  v.literal("chain_mismatch"),
  v.literal("provider_split"),
  v.literal("failed"),
  v.literal("completed"),
);

const syncErrorCode = v.union(
  v.literal("rpc_failure"),
  v.literal("receipt_failed"),
  v.literal("receipt_mismatch"),
  v.literal("log_decode_failed"),
  v.literal("projection_failure"),
  v.literal("cursor_conflict"),
  v.literal("reorg_beyond_checkpoints"),
  v.literal("missing_block_hash"),
  v.literal("provider_disagreement"),
  v.literal("unsafe_number"),
);

const cursorFailureCode = v.union(v.literal("cursor_hash_mismatch"), v.literal("reorg_beyond_checkpoints"));

export default defineSchema({
  deployments: defineTable({
    chainId: v.number(),
    network: v.union(v.literal("base-mainnet"), v.literal("base-sepolia")),
    vaultAddressLower: v.string(),
    vaultAddressChecksum: v.string(),
    deploymentBlock: v.number(),
    active: v.boolean(),
    updatedAt: v.number(),
  }).index("by_chain_vault", ["chainId", "vaultAddressLower"]),

  stocks: defineTable({
    chainId: v.number(),
    addressLower: v.string(),
    addressChecksum: v.string(),
    symbol: v.string(),
    name: v.string(),
    decimals: v.number(),
    reviewStatus: v.union(v.literal("verified"), v.literal("retired"), v.literal("rejected")),
    reviewedSourceUrl: v.string(),
    reviewedSourceHash: v.string(),
    reviewedAt: v.number(),
    b20Generation: v.literal("beryl"),
    sortOrder: v.number(),
    vaultSupported: v.union(v.boolean(), v.literal("unknown")),
    vaultSupportCheckedAt: v.optional(v.number()),
    vaultSupportCheckedBlock: v.optional(v.number()),
    proposedBy: v.optional(v.string()),
    approvedBy: v.optional(v.string()),
  })
    .index("by_chain_address", ["chainId", "addressLower"])
    .index("by_chain_status_order", ["chainId", "reviewStatus", "sortOrder"]),

  stockPromotions: defineTable({
    chainId: v.number(),
    addressLower: v.string(),
    addressChecksum: v.string(),
    intent: v.union(v.literal("verify"), v.literal("retire")),
    symbol: v.string(),
    name: v.string(),
    decimals: v.number(),
    b20Generation: v.literal("beryl"),
    sortOrder: v.number(),
    evidenceUrl: v.string(),
    evidenceHash: v.string(),
    proposedBy: v.string(),
    proposedAt: v.number(),
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    status: v.union(v.literal("proposed"), v.literal("approved")),
  })
    .index("by_chain_address_intent", ["chainId", "addressLower", "intent"])
    .index("by_status_proposed", ["status", "proposedAt"]),

  stockCandidates: defineTable({
    chainId: v.number(),
    addressLower: v.string(),
    addressChecksum: v.string(),
    factoryAddressLower: v.string(),
    creatorAddressLower: v.string(),
    creationTxHashLower: v.string(),
    creationLogIndex: v.number(),
    creationBlock: v.number(),
    creationBlockHashLower: v.string(),
    observedName: v.string(),
    observedSymbol: v.string(),
    observedDecimals: v.number(),
    observedVariant: v.string(),
    contractUriHash: v.optional(v.string()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    reviewDisposition: v.union(v.literal("unreviewed"), v.literal("promoted"), v.literal("rejected")),
    reviewedAt: v.optional(v.number()),
  })
    .index("by_chain_address", ["chainId", "addressLower"])
    .index("by_disposition_seen", ["reviewDisposition", "firstSeenAt"])
    .index("by_creation_event", ["chainId", "creationTxHashLower", "creationLogIndex"]),

  chainEvents: defineTable({
    chainId: v.number(),
    vaultAddressLower: v.string(),
    transactionHashLower: v.string(),
    transactionIndex: v.number(),
    logIndex: v.number(),
    blockNumber: v.number(),
    blockHashLower: v.string(),
    eventName: v.union(v.literal("GiftCreated"), v.literal("GiftClaimed")),
    giftIdDecimal: v.string(),
    senderLower: v.optional(v.string()),
    recipientLower: v.string(),
    stockLower: v.string(),
    amountRawDecimal: v.string(),
    unlockAt: v.optional(v.number()),
    noteHashLower: v.optional(v.string()),
    canonicality: observedCanonicality,
    seenViaWebhook: v.boolean(),
    seenViaReconciler: v.boolean(),
    firstSeenAt: v.number(),
    lastVerifiedAt: v.number(),
  })
    .index("by_event_key", ["chainId", "vaultAddressLower", "transactionHashLower", "logIndex"])
    .index("by_event_inclusion", [
      "chainId",
      "vaultAddressLower",
      "transactionHashLower",
      "logIndex",
      "blockHashLower",
    ])
    .index("by_gift", ["chainId", "vaultAddressLower", "giftIdDecimal"])
    .index("by_block", ["chainId", "vaultAddressLower", "blockNumber"])
    .index("by_canonicality", ["chainId", "vaultAddressLower", "canonicality", "blockNumber"]),

  gifts: defineTable({
    chainId: v.number(),
    vaultAddressLower: v.string(),
    giftIdDecimal: v.string(),
    senderLower: v.string(),
    recipientLower: v.string(),
    stockLower: v.string(),
    amountRawDecimal: v.string(),
    unlockAt: v.number(),
    noteHashLower: v.string(),
    state: v.union(v.literal("active"), v.literal("claimed")),
    createdTxHashLower: v.string(),
    createdLogIndex: v.number(),
    createdBlock: v.number(),
    createdBlockHashLower: v.string(),
    createdCanonicality: canonicality,
    claimedTxHashLower: v.optional(v.string()),
    claimedLogIndex: v.optional(v.number()),
    claimedBlock: v.optional(v.number()),
    claimedBlockHashLower: v.optional(v.string()),
    claimedCanonicality: v.optional(canonicality),
    lastChainVerifiedAt: v.number(),
    projectionVersion: v.number(),
  })
    .index("by_gift_key", ["chainId", "vaultAddressLower", "giftIdDecimal"])
    .index("by_chain_stock", ["chainId", "stockLower"])
    .index("by_recipient_chain", ["recipientLower", "chainId", "unlockAt"])
    .index("by_sender_chain", ["senderLower", "chainId", "createdBlock"]),

  noteAttachments: defineTable({
    chainId: v.number(),
    vaultAddressLower: v.string(),
    giftIdDecimal: v.string(),
    noteUtf8: v.string(),
    noteHashLower: v.string(),
    byteLength: v.number(),
    createdTxHashLower: v.string(),
    createdLogIndex: v.number(),
    verifiedSenderLower: v.string(),
    verifiedAt: v.number(),
  }).index("by_gift_key", ["chainId", "vaultAddressLower", "giftIdDecimal"]),

  webhookDeliveries: defineTable({
    provider: v.literal("cdp"),
    deliveryId: v.string(),
    bodyHash: v.string(),
    receivedAt: v.number(),
    chainId: v.number(),
    vaultAddressLower: v.string(),
    transactionHashLower: v.string(),
    logIndex: v.number(),
    blockNumber: v.number(),
    eventName: v.union(v.literal("GiftCreated"), v.literal("GiftClaimed")),
    processingStatus: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("applied"),
      v.literal("duplicate"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    eventKey: v.optional(v.string()),
    failureCode: v.optional(deliveryFailureCode),
  })
    .index("by_delivery_id", ["provider", "deliveryId"])
    .index("by_body_hash", ["bodyHash"])
    .index("by_received", ["receivedAt"])
    .index("by_status_next_attempt", ["processingStatus", "nextAttemptAt"]),

  indexerCursors: defineTable({
    pipeline: v.union(v.literal("vault-events"), v.literal("factory-candidates")),
    chainId: v.number(),
    contractAddressLower: v.string(),
    nextBlock: v.number(),
    lastCommittedBlock: v.optional(v.number()),
    lastCommittedBlockHashLower: v.optional(v.string()),
    checkpoints: v.array(v.object({ blockNumber: v.number(), blockHashLower: v.string() })),
    state: v.union(v.literal("active"), v.literal("halted")),
    failureCode: v.optional(cursorFailureCode),
    repairFromBlock: v.optional(v.number()),
    repairedBy: v.optional(v.string()),
    repairedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_pipeline_chain_contract", ["pipeline", "chainId", "contractAddressLower"]),

  syncRuns: defineTable({
    pipeline: syncPipeline,
    chainId: v.number(),
    contractAddressLower: v.string(),
    startedAt: v.number(),
    endedAt: v.number(),
    fromBlock: v.optional(v.number()),
    toBlock: v.optional(v.number()),
    safeHeadBlock: v.optional(v.number()),
    eventsApplied: v.optional(v.number()),
    outcome: syncOutcome,
    errorCode: v.optional(syncErrorCode),
    operator: v.optional(v.string()),
  })
    .index("by_pipeline_chain_ended", ["pipeline", "chainId", "endedAt"])
    .index("by_ended", ["endedAt"]),

  monitorSignals: defineTable({
    chainId: v.number(),
    vaultAddressLower: v.string(),
    observedAt: v.number(),
    signal: v.union(
      v.object({
        kind: v.literal("solvency"),
        stockLower: v.string(),
        totalEscrowedDecimal: v.string(),
        vaultBalanceDecimal: v.string(),
        status: v.union(v.literal("healthy"), v.literal("insolvent")),
      }),
      v.object({
        kind: v.literal("lag"),
        safeHeadBlock: v.number(),
        cursorBlock: v.number(),
        lagBlocks: v.number(),
      }),
      v.object({
        kind: v.literal("provider_split"),
        blockNumber: v.number(),
        primaryBlockHashLower: v.string(),
        secondaryBlockHashLower: v.string(),
      }),
    ),
  }).index("by_chain_observed", ["chainId", "observedAt"]),
});
