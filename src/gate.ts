/**
 * PrivacyGate — decision logic over detector results (SPEC A-1/A-2/D-5).
 * Scan function is injected so unit tests run without llama-server.
 * Default categories; privacy-router.json wiring lands in M4.
 */

import { maskText, type PredictedSpan } from "./viterbi.ts";

export const DEFAULT_WITHHOLD_CATEGORIES = ["account_number", "secret", "private_address"];
export const DEFAULT_REDACT_CATEGORIES = [
  "private_person", "private_email", "private_phone", "private_url", "private_date", "other_pii",
];

export type ScanFn = (text: string) => Promise<{ spans: PredictedSpan[] }>;

export interface GateDecision {
  action: "pass" | "redact" | "withhold";
  categories: string[];
  /** redact: masked text; withhold: store key */
  masked?: string;
  storeKey?: string;
  spans: PredictedSpan[];
}

export interface GateConfig {
  withholdCategories: string[];
  redactCategories: string[];
  spanConfidenceThreshold: number;
  retryTimeoutSec: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  withholdCategories: DEFAULT_WITHHOLD_CATEGORIES,
  redactCategories: DEFAULT_REDACT_CATEGORIES,
  spanConfidenceThreshold: 0.5,
  retryTimeoutSec: 5,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PrivacyGate {
  private cache = new Map<string, GateDecision>();
  private scan: ScanFn;
  private config: GateConfig;

  constructor(
    scan: ScanFn,
    config: Partial<GateConfig> = {},
  ) {
    this.scan = scan;
    this.config = { ...DEFAULT_GATE_CONFIG, ...config };
  }

  /** scan with D-1 retry: retry once per second until retryTimeoutSec elapses, then throw. */
  private async scanWithRetry(text: string): Promise<{ spans: PredictedSpan[] }> {
    const deadline = Date.now() + this.config.retryTimeoutSec * 1000;
    let lastErr: unknown;
    for (;;) {
      try {
        return await this.scan(text);
      } catch (e) {
        lastErr = e;
        if (Date.now() >= deadline) throw lastErr;
        await sleep(1000);
      }
    }
  }

  async decide(text: string): Promise<GateDecision> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const { spans: raw } = await this.scanWithRetry(text);
    // A.20 calibration: only confident spans count
    const spans = raw.filter((s) => s.score >= this.config.spanConfidenceThreshold);
    const categories = [...new Set(spans.map((s) => s.label))];
    let decision: GateDecision;
    if (spans.some((s) => this.config.withholdCategories.includes(s.label))) {
      decision = { action: "withhold", categories, spans };
    } else if (spans.length > 0) {
      decision = { action: "redact", categories, spans, masked: maskText(text, spans) };
    } else {
      decision = { action: "pass", categories: [], spans: [] };
    }
    if (this.cache.size >= 1000) this.cache.clear(); // bounded, no LRU needed for session scope
    this.cache.set(text, decision);
    return decision;
  }
}

export function placeholderText(storeKey: string, chars: number, categories: string[]): string {
  return [
    `[pi-privacy: tool result withheld — ${chars} chars, categories: ${categories.join(", ") || "unknown"}.`,
    ` Content stored locally with key ${storeKey}. Use the privacy_analyze tool to ask questions about it.]`,
  ].join("");
}
