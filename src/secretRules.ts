/**
 * Deterministic secret-rules layer (M7). Turns vendored gitleaks rules into PII spans
 * labeled `secret` (SPEC L-1: no new categories — the label already exists and is in
 * DEFAULT_WITHHOLD_CATEGORIES). Score is 1.0 by declaration (exact pattern match, not
 * measured confidence) and deliberately participates in spanConfidenceThreshold gating.
 *
 * Modes (privacy-router.json `secretRules`):
 *   off    — layer disabled, pipeline identical to v0.2.1
 *   loyal  — detect but let the caller redact in place instead of withholding (A-2
 *            instead of A-1; enforcement lives in the gate wiring, not here)
 *   default — curated high-signal pack (52 rules)
 *   all    — every rule that compiled (215)
 *
 * Detection is fail-safe: allowlist/stopword suppressions reduce false positives;
 * a rule that cannot compile is skipped at build time, never silently miscompiled.
 */

import { GITLEAKS_RULES, type CompiledRule } from "./rules/gitleaks.ts";
import type { PredictedSpan } from "./viterbi.ts";

export type SecretRulesMode = "off" | "loyal" | "default" | "all";

export const SECRET_RULES_MODES: SecretRulesMode[] = ["off", "loyal", "default", "all"];

export interface SecretRuleScanner {
  mode: SecretRulesMode;
  ruleCount: number;
  scan(text: string): PredictedSpan[];
}

export function isSecretRulesMode(v: unknown): v is SecretRulesMode {
  return typeof v === "string" && (SECRET_RULES_MODES as string[]).includes(v);
}

/** Keep maximal non-overlapping spans; ties resolved by earlier rule (stable input order). */
export function dedupeSpans(spans: PredictedSpan[]): PredictedSpan[] {
  const sorted = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const out: PredictedSpan[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.start >= lastEnd) {
      out.push(s);
      lastEnd = s.end;
    }
  }
  return out;
}

interface ActiveRule {
  re: RegExp;
  allowlist: RegExp[];
  stopwords: string[];
  keywords: string[];
}

export function createSecretRuleScanner(mode: SecretRulesMode): SecretRuleScanner | null {
  if (mode === "off") return null;
  const active = GITLEAKS_RULES.filter((r) => mode === "all" || r.default);
  const rules: ActiveRule[] = [];
  for (const r of active) rules.push(toActiveRule(r));
  return {
    mode,
    ruleCount: rules.length,
    scan(text: string): PredictedSpan[] {
      if (text.length === 0) return [];
      const spans: PredictedSpan[] = [];
      const lower = text.toLowerCase();
      for (const r of rules) {
        if (r.keywords.length > 0 && !r.keywords.some((k) => lower.includes(k))) continue;
        r.re.lastIndex = 0;
        for (const m of text.matchAll(r.re)) {
          const secret = m[0];
          if (secret.length === 0) continue;
          const secretLower = secret.toLowerCase();
          if (r.stopwords.some((s) => secretLower.includes(s))) continue;
          if (r.allowlist.some((al) => al.test(secret))) continue;
          const start = m.index ?? 0;
          spans.push({ start, end: start + secret.length, label: "secret", score: 1, origin: "rule" });
        }
      }
      return dedupeSpans(spans);
    },
  };
}

function toActiveRule(r: CompiledRule): ActiveRule {
  return {
    // matchAll needs 'g'; lastIndex reset per scan keeps repeated scans correct
    re: new RegExp(r.pattern, r.flags + "g"),
    allowlist: (r.allowlist ?? []).map((a) => new RegExp(a.pattern, a.flags)),
    stopwords: (r.stopwords ?? []).map((s) => s.toLowerCase()),
    keywords: r.keywords,
  };
}
