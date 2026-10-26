import { test } from "node:test";
import assert from "node:assert/strict";
// Claims covered: A-1 (withhold), A-2 (redact), D-5 (enforcement outside the LLM)
import { PrivacyGate, placeholderText } from "../src/gate.ts";
import { put, get } from "../src/store.ts";
import type { PredictedSpan } from "../src/viterbi.ts";

const s = (label: string, start: number, end: number): PredictedSpan => ({ label, start, end, score: 0.99 });

function gateWith(spans: PredictedSpan[]) {
  return new PrivacyGate(async () => ({ spans }));
}

test("withhold when span hits withholdCategories", async () => {
  const g = gateWith([s("account_number", 0, 10), s("private_person", 20, 30)]);
  const d = await g.decide("4026-3181-1900-8877 meets Daniel");
  assert.equal(d.action, "withhold");
  assert.deepEqual(d.categories, ["account_number", "private_person"]);
});

test("redact when spans hit redactCategories only", async () => {
  const g = gateWith([s("private_email", 0, 23)]);
  const d = await g.decide("daniels@meridiancap.com");
  assert.equal(d.action, "redact");
  assert.equal(d.masked, "[REDACTED_PRIVATE_EMAIL]");
});

test("pass on clean content", async () => {
  const g = gateWith([]);
  const d = await g.decide("quarterly report notes");
  assert.equal(d.action, "pass");
  assert.equal(d.spans.length, 0);
});

test("cache returns same decision without rescanning", async () => {
  let calls = 0;
  const g = new PrivacyGate(async () => { calls++; return { spans: [s("private_phone", 0, 12)] }; });
  const t = "415-555-0123";
  await g.decide(t);
  await g.decide(t);
  assert.equal(calls, 1);
});

test("placeholder carries key, size, categories", () => {
  const key = put({ toolCallId: "t1", toolName: "read", content: "x".repeat(100), categories: ["account_number"] });
  const p = placeholderText(key, 100, ["account_number"]);
  assert.ok(p.includes(key));
  assert.ok(p.includes("100"));
  assert.ok(p.includes("account_number"));
  assert.ok(p.includes("privacy_analyze"));
});

test("side store roundtrip", () => {
  const key = put({ toolCallId: "t2", toolName: "read", content: "secret content", categories: ["secret"] });
  const e = get(key);
  assert.ok(e);
  assert.equal(e!.content, "secret content");
  assert.deepEqual(e!.categories, ["secret"]);
  assert.equal(get("nope"), undefined);
});
