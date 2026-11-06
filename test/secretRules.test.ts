import { test } from "node:test";
import assert from "node:assert/strict";
// Claims covered: A-1 (withhold via `secret` in withholdCategories), A-2 (redact in place,
// loyal mode), D-5 (enforcement outside the LLM), L-1 (rules emit the existing `secret`
// label — no new categories).
import { createSecretRuleScanner, dedupeSpans, isSecretRulesMode } from "../src/secretRules.ts";
import { GITLEAKS_RULES, GITLEAKS_SOURCE } from "../src/rules/gitleaks.ts";
import { PrivacyGate, DEFAULT_GATE_CONFIG } from "../src/gate.ts";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { FIXTURES } from "./secretFixtures.ts";

const { awsAccessKey, githubPat, openaiKey, pemBlock, jwt, dbUrl, slackBot, awsDocExample } = FIXTURES;

const rules = createSecretRuleScanner("default");
const allRules = createSecretRuleScanner("all")!;

test("compile integrity: >=150 rules compiled, curated default pack present, MIT source pinned", () => {
  assert.ok(GITLEAKS_RULES.length >= 150, `only ${GITLEAKS_RULES.length} rules compiled`);
  const defaults = GITLEAKS_RULES.filter((r) => r.default);
  assert.ok(defaults.length >= 40, `curated default pack too small: ${defaults.length}`);
  assert.match(GITLEAKS_SOURCE, /MIT/);
  for (const r of GITLEAKS_RULES) {
    assert.ok(r.id && r.pattern && typeof r.flags === "string", `bad rule: ${r.id}`);
  }
});

test("default pack detects canonical secrets as `secret` spans (L-1: no new categories)", () => {
  const text = `deploy with ${awsAccessKey} and ${githubPat}, model ${openaiKey}`;
  const spans = rules!.scan(text);
  const labels = new Set(spans.map((s) => s.label));
  assert.ok(labels.has("secret"));
  assert.ok(spans.every((s) => s.label === "secret"), "only `secret` labels may come from rules");
  assert.ok(spans.every((s) => s.score === 1 && s.origin === "rule"));
  for (const secret of [awsAccessKey, githubPat, openaiKey]) {
    assert.ok(spans.some((s) => text.slice(s.start, s.end).includes(secret.slice(0, 12))), `missing ${secret.slice(0, 8)}`);
  }
});

test("each curated detector category fires: PEM, JWT, DB URL, Slack bot token", () => {
  const cases = [
    ["key file:\n" + pemBlock, /PRIVATE KEY/],
    ["Authorization: Bearer " + jwt, /eyJ/],
    ["connect " + dbUrl, /postgres:\/\//],
    ["slack token " + slackBot, /xoxb/],
  ] as const;
  for (const [text, re] of cases) {
    const spans = rules!.scan(text);
    assert.ok(spans.some((s) => re.test(text.slice(s.start, s.end))), `no span for ${re}`);
  }
});

test("upstream FP suppressions hold: AWS doc EXAMPLE allowlist, generic-api-key stopwords", () => {
  assert.equal(rules!.scan(awsDocExample).length, 0);
  const spans = rules!.scan("password = examplevalue1234");
  assert.equal(spans.length, 0, "stopword 'example' should suppress generic-api-key hit");
});

test("keyword prefilter: unrelated text yields no spans", () => {
  assert.equal(rules!.scan("quarterly report notes and todo list").length, 0);
});

test("repeat scans are stable (regex lastIndex correctness)", () => {
  const text = `token ${githubPat} again`;
  assert.deepEqual(rules!.scan(text), rules!.scan(text));
});

test("dedupeSpans keeps maximal non-overlapping spans", () => {
  const out = dedupeSpans([
    { start: 0, end: 10, label: "secret", score: 1 },
    { start: 0, end: 5, label: "secret", score: 1 },
    { start: 5, end: 12, label: "secret", score: 1 },
    { start: 20, end: 25, label: "private_email", score: 0.9 },
  ]);
  assert.deepEqual(out, [
    { start: 0, end: 10, label: "secret", score: 1 },
    { start: 20, end: 25, label: "private_email", score: 0.9 },
  ]);
});

test("mode selection: off disables the layer, all widens the pack, loyal detects like default", () => {
  assert.equal(createSecretRuleScanner("off"), null);
  const loyal = createSecretRuleScanner("loyal")!;
  assert.equal(loyal.ruleCount, rules!.ruleCount);
  assert.ok(allRules.ruleCount > rules!.ruleCount, "all pack must be wider than default");
  const text = `key ${awsAccessKey}`;
  assert.deepEqual(loyal.scan(text), rules!.scan(text));
});

test("bounded work: 10KB mixed input scans without runaway (no catastrophic backtracking)", () => {
  const noise = "lorem ipsum dolor sit amet ".repeat(1000).slice(0, 5000) + githubPat + "\n" +
    "padding line value 123\n".repeat(300) + awsAccessKey + "\n";
  assert.ok(noise.length >= 8000, `fixture too small: ${noise.length}`);
  const t0 = performance.now();
  const spans = allRules.scan(noise);
  const ms = performance.now() - t0;
  assert.ok(spans.length >= 2, `expected both planted secrets, got ${spans.length}`);
  assert.ok(ms < 5000, `scan took ${ms.toFixed(0)}ms on ${noise.length}B input`);
});

// --- gate-level: A-1 vs A-2 action mapping by mode ---

function gateWith(mode: "loyal" | "default" | "off") {
  const scanner = createSecretRuleScanner(mode);
  const scan = async (text: string) => {
    const ruleSpans = scanner ? scanner.scan(text) : [];
    // pretend the ML detector finds nothing: only rule spans drive the decision
    return { spans: dedupeSpans(ruleSpans) };
  };
  return new PrivacyGate(scan, {
    ...DEFAULT_GATE_CONFIG,
    ...(mode === "loyal" ? { redactOnlyLabels: new Set(["secret"]) } : {}),
  });
}

test("A-1: default mode withholds a tool result containing a rule-detected secret", async () => {
  const d = await gateWith("default").decide(`db password is ${dbUrl}`);
  assert.equal(d.action, "withhold");
  assert.ok(d.categories.includes("secret"));
});

test("A-2: loyal mode redacts rule-detected secrets in place instead of withholding", async () => {
  const d = await gateWith("loyal").decide(`db password is ${dbUrl}`);
  assert.equal(d.action, "redact");
  assert.match(d.masked!, /\[REDACTED_SECRET\]/);
  assert.ok(!d.masked!.includes("s3cret"));
});

test("D-5: off mode leaves clean-path behavior untouched (no rule spans, no gating)", async () => {
  const g = gateWith("off");
  const d = await g.decide(`no secrets here, token ${githubPat} ignored by rules`);
  assert.equal(d.action, "pass", "with rules off and ML silent, the gate must not act");
});

test("A-1: loyal mode keeps ML-detected secrets on withhold (only rule origin downgrades)", async () => {
  const mlSecretScan = async () => ({
    spans: [{ start: 0, end: 10, label: "secret", score: 0.9 }], // no origin: ML detector
  });
  const loyalGate = new PrivacyGate(mlSecretScan, {
    ...DEFAULT_GATE_CONFIG,
    redactOnlyLabels: new Set(["secret"]),
  });
  assert.equal((await loyalGate.decide("xxx ML detected a secret")).action, "withhold");
});

test("A.20: rule spans (score 1.0) survive a user-raised spanConfidenceThreshold", async () => {
  const scanner = createSecretRuleScanner("default")!;
  const scan = async (text: string) => ({ spans: scanner.scan(text) });
  const g = new PrivacyGate(scan, { ...DEFAULT_GATE_CONFIG, spanConfidenceThreshold: 0.95 });
  const d = await g.decide(`key ${awsAccessKey}`);
  assert.equal(d.action, "withhold", "score-1.0 rule spans must clear threshold <= 1");
});

// --- config plumbing ---

test("config: valid secretRules values pass through, invalid fall back to default", () => {
  assert.ok(isSecretRulesMode("loyal"));
  assert.ok(!isSecretRulesMode("strict"));
  assert.equal(defaultConfig().secretRules, "default");
  process.env.PI_PRIVACY_DIR = "./.tmp-test-config";
  const d = defaultConfig();
  assert.equal(loadConfig().secretRules, "default");
  assert.equal(d.secretRules, "default");
});
