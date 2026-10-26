/**
 * M6 canary suite (SPEC E-1): planted PII in synthetic files must be caught and
 * withheld; benign files must pass or produce only redactions, not withholds.
 * Requires llama-server (skipped when unreachable). Claims: A-1, A-2, E-1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PiiDetector } from "../src/detector.ts";
import { PrivacyGate, DEFAULT_WITHHOLD_CATEGORIES, DEFAULT_REDACT_CATEGORIES } from "../src/gate.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPIKE = ROOT + "spike/";
const CANARY = ROOT + "bench/canary/";
const BENIGN = ROOT + "bench/benign/";
const MODEL_DIR = process.env.PII_TEST_MODEL_DIR ?? SPIKE;
const SERVER = process.env.PII_TEST_SERVER ?? "http://127.0.0.1:8080";

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${SERVER}/health`)).ok;
  } catch {
    return false;
  }
}

const canRun = () =>
  existsSync(MODEL_DIR + "/tokenizer.json") &&
  existsSync(MODEL_DIR + "/heads.safetensors") &&
  existsSync(MODEL_DIR + "/pplx-pii-masking-backbone-f16.gguf");

function gate(): PrivacyGate {
  const detector = new PiiDetector(MODEL_DIR, SERVER);
  return new PrivacyGate((text) => detector.scan(text), {
    withholdCategories: DEFAULT_WITHHOLD_CATEGORIES,
    redactCategories: DEFAULT_REDACT_CATEGORIES,
    spanConfidenceThreshold: 0.5,
    retryTimeoutSec: 5,
  });
}

const canaryFiles = readdirSync(CANARY);

for (const file of canaryFiles) {
  test(`canary ${file}: withhold-category PII withheld (A-1)`, { skip: !canRun() }, async (t) => {
    if (!(await serverUp())) { t.skip("llama-server not running"); return; }
    const text = readFileSync(CANARY + file, "utf8");
    const d = await gate().decide(text);
    assert.equal(d.action, "withhold", `expected withhold, got ${d.action}; spans: ${JSON.stringify(d.spans.map((s) => [s.label, s.score]))}`);
  });
}

test("benign corpus: no withholds, FP spans measured (E-1)", { skip: !canRun() }, async (t) => {
  if (!(await serverUp())) { t.skip("llama-server not running"); return; }
  const g = gate();
  let fpSpans = 0, totalSpans = 0;
  for (const file of readdirSync(BENIGN)) {
    const text = readFileSync(BENIGN + file, "utf8");
    const d = await g.decide(text);
    assert.notEqual(d.action, "withhold", `${file} was withheld — false positive`);
    totalSpans += d.spans.length;
    fpSpans += d.spans.length; // any span in a clean corpus is a false positive
  }
  console.log(`benign corpus: ${fpSpans} false-positive span(s) across ${readdirSync(BENIGN).length} files`);
  assert.ok(fpSpans <= 1, `too many false positives: ${fpSpans}`);
});
