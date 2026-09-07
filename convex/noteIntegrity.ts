import { keccak256, stringToBytes } from "viem";
import type { Doc } from "./_generated/dataModel";

export function noteMatchesGift(note: Doc<"noteAttachments">, gift: Doc<"gifts">) {
  return (
    note.createdTxHashLower === gift.createdTxHashLower &&
    note.createdLogIndex === gift.createdLogIndex &&
    note.noteHashLower === gift.noteHashLower &&
    keccak256(stringToBytes(note.noteUtf8)).toLowerCase() === gift.noteHashLower
  );
}
