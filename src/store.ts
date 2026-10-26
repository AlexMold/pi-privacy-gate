/**
 * Session-scoped side store for withheld tool results (SPEC A-1).
 * Content never enters the conversation context; privacy_analyze (M3) reads it here.
 */

import { createHash } from "node:crypto";

export interface WithheldEntry {
  key: string;
  toolCallId: string;
  toolName: string;
  content: string;
  categories: string[];
  ts: number;
}

const entries = new Map<string, WithheldEntry>();

export function put(entry: Omit<WithheldEntry, "key" | "ts">): string {
  const key = createHash("sha256").update(entry.content).digest("hex").slice(0, 16);
  entries.set(key, { ...entry, key, ts: Date.now() });
  return key;
}

export function get(key: string): WithheldEntry | undefined {
  return entries.get(key);
}

export function list(): WithheldEntry[] {
  return [...entries.values()];
}
