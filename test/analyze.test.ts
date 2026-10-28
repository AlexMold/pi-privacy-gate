import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWithheld, localModelFromEnv, ANALYZE_SYSTEM_PROMPT, diffMask } from "../src/analyze.ts";
import { put } from "../src/store.ts";

test("returns masked answer for a stored file", async () => {
  const key = put({ toolCallId: "t1", toolName: "read", content: "Account 4026-3181-1900-8877 balance $1200", categories: ["account_number"] });
  const complete = async (_ref: { provider: string; model: string }, _sys: string, user: string) => {
    assert.ok(user.includes("4026-3181-1900-8877")); // local model sees the raw content
    return "The account 4026-3181-1900-8877 has balance $1200.";
  };
  const rescan = async (text: string) => text.replace("4026-3181-1900-8877", "[REDACTED_ACCOUNT_NUMBER]");
  const res = await analyzeWithheld(key, "what is the balance?", complete, rescan);
  assert.ok(!res.isError);
  assert.equal(res.content, "The account [REDACTED_ACCOUNT_NUMBER] has balance $[REDACTED_verbatim].");
});

test("errors on unknown fileRef", async () => {
  const res = await analyzeWithheld("nope", "q", async () => "x", async (t) => t);
  assert.ok(res.isError);
  assert.ok(res.content.includes("nope"));
});

test("fail-closed when rescan cannot verify the answer (D-3)", async () => {
  const key = put({ toolCallId: "t2", toolName: "read", content: "secret", categories: ["secret"] });
  const res = await analyzeWithheld(key, "q", async () => "answer with PII", async () => { throw new Error("detector down"); });
  assert.ok(res.isError);
  assert.ok(res.content.includes("withheld"));
});

test("diffMask masks literal numbers echoed from the source (D-3 layer-1)", () => {
  const doc = "Invoice 5000, tax 690.";
  assert.equal(diffMask("The total is 5000.", doc), "The total is [REDACTED_verbatim].");
  assert.equal(diffMask("Tax was 690.", doc), "Tax was 690."); // 3 chars < MIN_NUM_RUN: left as-is
  assert.equal(diffMask("Invoiced 2024.", "Invoiced 2024."), "Invoiced [REDACTED_verbatim].");
});

test("diffMask leaves computed numbers absent from the source (known limit)", () => {
  const doc = "Invoice 5000, tax 690.";
  // 4310 is derived (5000 - 690): not in the doc, so no verbatim match
  assert.equal(diffMask("You keep 4310 after tax.", doc), "You keep 4310 after tax.");
});

test("diffMask ignores runs shorter than the minimum", () => {
  assert.equal(diffMask("Row 1 of 12", "Row 1 of 12"), "Row 1 of 12"); // "1" and "12" < 4 chars
  assert.equal(diffMask("Built 2024", "Built 2024"), "Built [REDACTED_verbatim]"); // 4 chars
});

test("env fallback defaults to ollama/qwen", () => {
  const ref = localModelFromEnv();
  assert.equal(ref.provider, "ollama");
  assert.equal(ref.model, "qwen2.5:3b");
});

test("system prompt instructs factual answers from the document only", () => {
  assert.ok(ANALYZE_SYSTEM_PROMPT.includes("from the document only"));
});
