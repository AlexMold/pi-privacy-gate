import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWithheld, localModelFromEnv, ANALYZE_SYSTEM_PROMPT } from "../src/analyze.ts";
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
  assert.equal(res.content, "The account [REDACTED_ACCOUNT_NUMBER] has balance $1200.");
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

test("env fallback defaults to ollama/qwen", () => {
  const ref = localModelFromEnv();
  assert.equal(ref.provider, "ollama");
  assert.equal(ref.model, "qwen2.5:3b");
});

test("system prompt instructs factual answers from the document only", () => {
  assert.ok(ANALYZE_SYSTEM_PROMPT.includes("from the document only"));
});
