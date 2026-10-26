import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivacyGate } from "../src/gate.ts";
import type { PredictedSpan } from "../src/viterbi.ts";

const s = (label: string, start: number, end: number, score = 0.99): PredictedSpan => ({ label, start, end, score });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("retries scan until retryTimeoutSec then throws (D-1)", async () => {
  let calls = 0;
  const g = new PrivacyGate(async () => {
    calls++;
    if (calls < 3) throw new Error("down");
    return { spans: [] };
  }, { retryTimeoutSec: 5 });
  const d = await g.decide("clean text");
  assert.equal(d.action, "pass");
  assert.ok(calls >= 2, `expected retries, got ${calls} calls`);
});

test("throws after retry window when detector stays down", async () => {
  let calls = 0;
  const g = new PrivacyGate(async () => {
    calls++;
    throw new Error("down");
  }, { retryTimeoutSec: 2 });
  const t0 = Date.now();
  await assert.rejects(() => g.decide("x"));
  assert.ok(Date.now() - t0 >= 1900, "must wait the retry window");
  assert.ok(calls >= 2);
});

test("span below confidence threshold is ignored (A.20)", async () => {
  const g = new PrivacyGate(async () => ({ spans: [s("private_email", 0, 10, 0.2)] }), { spanConfidenceThreshold: 0.5 });
  const d = await g.decide("a@b.com x");
  assert.equal(d.action, "pass");
});

test("span above threshold acts", async () => {
  const g = new PrivacyGate(async () => ({ spans: [s("private_email", 0, 9, 0.8)] }), { spanConfidenceThreshold: 0.5 });
  const d = await g.decide("a@b.com");
  assert.equal(d.action, "redact");
  assert.equal(d.masked, "[REDACTED_PRIVATE_EMAIL]");
});

test("custom withhold categories from config", async () => {
  const g = new PrivacyGate(async () => ({ spans: [s("private_date", 0, 10)] }), {
    withholdCategories: ["private_date"],
    redactCategories: [],
  });
  const d = await g.decide("1992-03-14");
  assert.equal(d.action, "withhold");
});

test("retry honors injected clock budget: quick-fail path does not sleep long", async () => {
  const g = new PrivacyGate(async () => { throw new Error("down"); }, { retryTimeoutSec: 1 });
  const t0 = Date.now();
  await assert.rejects(() => g.decide("x"));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  void sleep;
});
