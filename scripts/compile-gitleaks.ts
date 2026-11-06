/**
 * Compile vendored gitleaks rules → src/rules/gitleaks.ts (M7 / TODO 8.2-8.3).
 *
 *   node scripts/compile-gitleaks.ts
 *
 * Reads vendor/gitleaks.yaml, compiles every pattern to JS RegExp (explicit strategy
 * order, see compileJsRegex), emits generated data + a skipped report. Fails loudly
 * (exit 1) when a curated default rule ID is missing from the vendored YAML (IDs drift
 * between gitleaks releases — build-step constraint, A.20) or when fewer than
 * MIN_COMPILED rules compile.
 *
 * Go RE2 → JS traps handled:
 *   - leading (?i) inline flags → JS `i`/`s`/`m` flags
 *   - (?-i:...) modifier groups → `v` flag (ES2025 modifiers, Node >= 24)
 *   - \z (Go end-of-text) → `$` (JS, no `m` flag) — the only semantic rewrite, applied
 *     verbatim and reported
 *   - identity-escape traps (\p \P \z \Z \A \Q \u{...) in plain mode are rejected, never
 *     silently miscompiled: \z is rewritten, the rest route to u/v-flag strategies or skip
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { load } from "js-yaml";

const MIN_COMPILED = 150;

/** Curated default pack (TODO 8.3): high-signal provider keys, everything else opt-in via "all". */
const CURATED_DEFAULT_IDS = [
  // cloud
  "aws-access-token",
  "aws-amazon-bedrock-api-key-long-lived",
  "aws-amazon-bedrock-api-key-short-lived",
  "gcp-api-key",
  "azure-ad-client-secret",
  "cloudflare-api-key",
  "cloudflare-global-api-key",
  "cloudflare-origin-ca-key",
  "digitalocean-access-token",
  "digitalocean-pat",
  "heroku-api-key",
  "heroku-api-key-v2",
  "hashicorp-tf-api-token",
  "hashicorp-tf-password",
  "vault-batch-token",
  "vault-service-token",
  "yandex-aws-access-token",
  // VCS
  "github-pat",
  "github-fine-grained-pat",
  "github-app-token",
  "github-oauth",
  "github-refresh-token",
  "gitlab-pat",
  "gitlab-ptt",
  "gitlab-rrt",
  "gitlab-deploy-token",
  "gitlab-oauth-app-secret",
  "gitlab-scim-token",
  "gitlab-session-cookie",
  "npm-access-token",
  "pypi-upload-token",
  // AI providers
  "openai-api-key",
  "anthropic-api-key",
  "anthropic-admin-api-key",
  "huggingface-access-token",
  "huggingface-organization-api-token",
  "cohere-api-token",
  // generic / credentials
  "generic-api-key",
  "private-key",
  "jwt",
  "jwt-base64",
  // messaging / payment (common in agent sessions)
  "slack-app-token",
  "slack-bot-token",
  "slack-user-token",
  "slack-webhook-url",
  "sendgrid-api-token",
  "twilio-api-key",
  "stripe-access-token",
  "linear-api-key",
  "linear-client-secret",
  "netlify-access-token",
];

/**
 * Clean-room additions (not from gitleaks): DB/URL connection strings with embedded
 * credentials. gitleaks has no such rules (its generic-api-key never fires on a bare
 * connection string — no keyword). No keywords: always in the prefilter.
 */
const PI_EXTRA_RULES = [
  {
    id: "pi-db-url-credentials",
    description: "Database/connection URL with embedded user:password credentials (postgres, mysql, mongo, redis, amqp)",
    regex:
      "(?i)\\b(?:postgres(?:ql)?|mysql|maria|mongodb(?:\\+srv)?|redis|rediss|amqps?|mssql|jdbc:[a-z0-9]+):\\/\\/[^\\s:@\\/]+:[^\\s@]+@[^\\s'\"<>]+",
    keywords: [] as string[],
  },
];

interface JsRegex {
  pattern: string;
  flags: string;
}

/** Leading Go inline flags `(?imsx)`, lowercased. */
const LEAD_FLAGS = /^\(\?([a-z]+)\)/;

const hasPlainTraps = (p: string): boolean => /\\[pPzZAGQo]/.test(p) || /\\u\{/.test(p);

/** Go inline flags -> JS flags; null when unrepresentable (e.g. x free-spacing). */
function goFlagsToJs(f: string): string | null {
  return /^[ism]*$/.test(f) ? f : null;
}

/** Walk a regex source, skipping escapes and char classes; call cb with char and index. */
function scanRegex(p: string, cb: (ch: string, i: number) => void): void {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    cb(ch, i);
  }
}

/**
 * Go bare mid-pattern flags like `SG\\.(?i)[a-z0-9]` apply to the rest of the enclosing
 * group. JS needs a modifier group: `SG\\.(?i:[a-z0-9])` (compiles with the v flag).
 * Wraps each bare mid-pattern (?flags) in the equivalent (?flags:...) group.
 */
function wrapBareFlags(p: string): string | null {
  const RE = /\(\?([a-z]+)\)/g;
  for (;;) {
    let m: RegExpExecArray | null;
    RE.lastIndex = 0;
    let target: { start: number; end: number; flags: string } | null = null;
    while ((m = RE.exec(p))) {
      if (m.index === 0) continue; // leading flags: handled by LEAD_FLAGS strip
      target = { start: m.index, end: RE.lastIndex, flags: m[1]! };
      break;
    }
    if (!target) return p;
    // find nearest enclosing unclosed '(' before target.start
    const stack: number[] = [];
    scanRegex(p, (ch, i) => {
      if (i >= target!.start) return;
      if (ch === "(") stack.push(i);
      if (ch === ")") stack.pop();
    });
    const open = stack.at(-1);
    // its matching close
    let depth = 1;
    let close = p.length;
    scanRegex(p, (ch, i) => {
      if (i <= target!.end || depth === 0) return;
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) close = i;
      }
    });
    const inner = p.slice(target.end, close);
    const before = p.length;
    p = p.slice(0, target.start) + `(?${target.flags}:` + inner + ")" + p.slice(close);
    if (p.length > before + 64) return null; // transform runaway guard
  }
}

function tryCompile(p: string, flags: string): JsRegex | null {
  try {
    // eslint-disable-next-line no-new
    new RegExp(p, flags);
    return { pattern: p, flags };
  } catch {
    return null;
  }
}

/** Deterministic strategy order; first success wins. \z is rewritten (Go -> JS). */
function compileJsRegex(raw: string): { ok: true; js: JsRegex; note?: string } | { ok: false; reason: string } {
  let p = raw.replaceAll("(?P<", "(?<"); // Go named-group syntax -> JS
  const notes: string[] = [];
  if (/\\z/.test(p)) {
    p = p.replaceAll("\\z", "$");
    notes.push("\\z -> $");
  }
  if (/\\Z|\\A|\\Q|\\E/.test(p)) return { ok: false, reason: "Go-only anchor \\Z/\\A/\\Q\\E" };
  // bare mid-pattern flags (?i) -> modifier groups (?i:...), compiled with the v flag
  let needV = false;
  for (let guard = 0; guard < 16; guard++) {
    const wrapped = wrapBareFlags(p);
    if (wrapped === null) return { ok: false, reason: "bare mid-pattern (?flags) wrapper failed" };
    if (wrapped === p) break;
    p = wrapped;
    needV = true;
  }
  if (needV) notes.push("bare (?flags) scoped to (?flags:...)", "v flag");
  const lead = p.match(LEAD_FLAGS);
  const leadFlags = lead ? goFlagsToJs(lead[1]!) : null;
  const rest = lead ? p.replace(LEAD_FLAGS, "") : p;
  const candidates: Array<{ p: string; f: string }> = [];
  if (needV) {
    if (!lead) candidates.push({ p, f: "v" });
    if (leadFlags) candidates.push({ p: rest, f: leadFlags + "v" });
  } else {
    if (!lead && !hasPlainTraps(p)) candidates.push({ p, f: "" });
    if (leadFlags) candidates.push({ p: rest, f: leadFlags });
    if (hasPlainTraps(rest)) candidates.push({ p: rest, f: (leadFlags ?? "") + "u" });
    candidates.push({ p: rest, f: (leadFlags ?? "") + "v" });
    if (!lead) candidates.push({ p, f: "u" }, { p, f: "v" });
  }
  for (const c of candidates) {
    const js = tryCompile(c.p, c.f);
    if (js) return { ok: true, js, note: notes.join("; ") || undefined };
  }
  return { ok: false, reason: "no JS RegExp strategy compiles (e.g. RE2-only syntax)" };
}

function main() {
  const doc = load(readFileSync("vendor/gitleaks.yaml", "utf8")) as {
    source: string;
    commit: string;
    rules: Array<{
      id: string;
      description: string;
      regex: string;
      keywords?: string[];
      matchAllowlists?: Array<{ regexes?: string[]; stopwords?: string[] }>;
    }>;
  };

  const compiled: Array<Record<string, unknown>> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const compiledIds = new Set<string>();

  for (const r of doc.rules) {
    const main = compileJsRegex(r.regex);
    if (!main.ok) {
      skipped.push({ id: r.id, reason: `regex: ${main.reason}` });
      continue;
    }
    const allowlist: JsRegex[] = [];
    const stopwords: string[] = [];
    let allowSkipped = 0;
    for (const block of r.matchAllowlists ?? []) {
      for (const re of block.regexes ?? []) {
        const js = compileJsRegex(re);
        if (js.ok) allowlist.push(js.js);
        else allowSkipped++;
      }
      stopwords.push(...(block.stopwords ?? []));
    }
    compiledIds.add(r.id);
    compiled.push({
      id: r.id,
      description: r.description,
      pattern: main.js.pattern,
      flags: main.js.flags,
      keywords: (r.keywords ?? []).map((k) => k.toLowerCase()),
      ...(allowlist.length ? { allowlist } : {}),
      ...(stopwords.length ? { stopwords } : {}),
      default: false,
      ...(main.note || allowSkipped ? { note: [main.note, allowSkipped ? `${allowSkipped} allowlist regex(es) skipped` : ""].filter(Boolean).join("; ") } : {}),
    });
  }

  for (const extra of PI_EXTRA_RULES) {
    const js = compileJsRegex(extra.regex);
    if (!js.ok) throw new Error(`pi extra rule ${extra.id} does not compile: ${js.reason}`);
    compiledIds.add(extra.id);
    compiled.push({
      id: extra.id,
      description: extra.description,
      pattern: js.js.pattern,
      flags: js.js.flags,
      keywords: extra.keywords,
      default: true,
      note: js.note,
    });
  }

  // A.20 build-step constraint: every curated ID must exist, loudly.
  const missing = CURATED_DEFAULT_IDS.filter((id) => !compiledIds.has(id));
  if (missing.length > 0) {
    console.error(`FAIL: curated default IDs missing from vendored rules: ${missing.join(", ")}`);
    console.error("The pinned gitleaks release renamed/dropped rules — update the curated list explicitly.");
    process.exit(1);
  }
  for (const c of compiled) {
    if (CURATED_DEFAULT_IDS.includes(c.id as string)) c.default = true;
  }

  const defaults = compiled.filter((c) => c.default).length;
  if (compiled.length < MIN_COMPILED) {
    console.error(`FAIL: only ${compiled.length}/${doc.rules.length} rules compile (need >= ${MIN_COMPILED})`);
    process.exit(1);
  }

  const header = `// GENERATED by scripts/compile-gitleaks.ts from vendor/gitleaks.yaml — do not edit.
// Source: ${doc.source} commit ${doc.commit} (MIT). See vendor/README.md.
// Skipped upstream rules (${skipped.length}): ${skipped.map((s) => s.id).join(", ") || "none"}
// Each allowlist regex compiles at module load with the recorded flags; entries listed in
// 'note' were dropped by the compile step (see scripts/compile-gitleaks.ts).

export interface CompiledRule {
  id: string;
  description: string;
  /** JS RegExp source (already transformed from Go RE2, e.g. leading (?i) stripped) */
  pattern: string;
  flags: string;
  /** OR prefilter, lowercase: run the rule only if one keyword is in the text */
  keywords: string[];
  /** match-target suppression regexes, applied to the captured secret */
  allowlist?: Array<{ pattern: string; flags: string }>;
  /** case-insensitive substring suppressions on the captured secret */
  stopwords?: string[];
  /** curated default pack (secretRules: "default") */
  default: boolean;
  /** compile-step notes (semantic rewrites, dropped allowlists) */
  note?: string;
}

export const GITLEAKS_SOURCE = ${JSON.stringify(`${doc.source} commit ${doc.commit} (MIT)`)};

export const GITLEAKS_RULES: CompiledRule[] = ${JSON.stringify(compiled, null, 2)};
`;

  mkdirSync("src/rules", { recursive: true });
  writeFileSync("src/rules/gitleaks.ts", header);
  console.log(
    `src/rules/gitleaks.ts written: ${compiled.length} rules compile of ${doc.rules.length} upstream, ` +
      `${skipped.length} skipped, ${defaults} in curated default pack`,
  );
  if (skipped.length > 0) console.log("skipped:", skipped.map((s) => `${s.id} (${s.reason.slice(0, 60)})`).join("; "));
}

main();
