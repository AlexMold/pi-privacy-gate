/**
 * Integration tests for PiiDetector — require llama-server with PII-Tracer-GGUF
 * (skip when unreachable). Canonical examples from the HF README + spike.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiiDetector } from "../src/detector.ts";

const SPIKE = fileURLToPath(new URL("../spike/", import.meta.url));
/** Installed detector weights (from /privacy-setup); falls back to a local spike checkout. */
function defaultModelDir(): string {
  const installed = join(homedir(), ".pi-privacy", "model");
  return existsSync(join(installed, "tokenizer.json")) ? installed : SPIKE;
}

const MODEL_DIR = process.env.PII_TEST_MODEL_DIR ?? defaultModelDir();
const SERVER = process.env.PII_TEST_SERVER ?? "http://127.0.0.1:8080";

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${SERVER}/health`)).ok;
  } catch {
    return false;
  }
}

function canRun() {
  return existsSync(MODEL_DIR + "/tokenizer.json") &&
    existsSync(MODEL_DIR + "/heads.safetensors") &&
    existsSync(MODEL_DIR + "/pplx-pii-masking-backbone-f16.gguf");
}

test("canonical example: person/email/phone spans", { skip: !canRun() }, async (t) => {
  if (!(await serverUp())) { t.skip("llama-server not running"); return; }
  const detector = new PiiDetector(MODEL_DIR, SERVER);
  const text = "Hi, I'm Daniel Whitfield, you can reach me at daniels@meridiancap.com or 415-555-0123.";
  const res = await detector.scan(text);
  const labels = res.spans.map((s) => [s.label, text.slice(s.start, s.end), s.score]);
  const byLabel = Object.fromEntries(res.spans.map((s) => [s.label, s]));
  assert.ok(byLabel.private_person, `no person: ${JSON.stringify(labels)}`);
  assert.ok(byLabel.private_email, `no email: ${JSON.stringify(labels)}`);
  assert.ok(byLabel.private_phone, `no phone: ${JSON.stringify(labels)}`);
  assert.equal(text.slice(byLabel.private_person.start, byLabel.private_person.end), "Daniel Whitfield");
  assert.equal(text.slice(byLabel.private_email.start, byLabel.private_email.end), "daniels@meridiancap.com");
  assert.ok(byLabel.private_person.score > 0.9 && byLabel.private_email.score > 0.9);
  assert.equal(res.chunks, 1);
});

test("cyrillic name detection", { skip: !canRun() }, async (t) => {
  if (!(await serverUp())) { t.skip("llama-server not running"); return; }
  const detector = new PiiDetector(MODEL_DIR, SERVER);
  const text = "Привет, меня зовут Александр Грибков, мой телефон +351 923 272 925";
  const res = await detector.scan(text);
  const person = res.spans.find((s) => s.label === "private_person");
  assert.ok(person, `no person span: ${JSON.stringify(res.spans.map((s) => [s.label, text.slice(s.start, s.end)]))}`);
  assert.equal(text.slice(person.start, person.end), "Александр Грибков");
});

test("account number and secret categories", { skip: !canRun() }, async (t) => {
  if (!(await serverUp())) { t.skip("llama-server not running"); return; }
  const detector = new PiiDetector(MODEL_DIR, SERVER);
  const text = "My account number is 4026-3181-1900-8877. API key: sk-live-9f8e7d6c5b4a";
  const res = await detector.scan(text);
  const byLabel = Object.fromEntries(res.spans.map((s) => [s.label, s]));
  assert.ok(byLabel.account_number, `no account_number: ${JSON.stringify(res.spans.map((s) => s.label))}`);
  assert.equal(text.slice(byLabel.account_number.start, byLabel.account_number.end), "4026-3181-1900-8877");
  assert.ok(byLabel.secret, `no secret: ${JSON.stringify(res.spans.map((s) => s.label))}`);
});

test("multi-chunk scan covers long text", { skip: !canRun() }, async (t) => {
  if (!(await serverUp())) { t.skip("llama-server not running"); return; }
  const detector = new PiiDetector(MODEL_DIR, SERVER);
  const filler = "expenses invoice meeting schedule budget analysis notes summary review update ";
  const text = filler.repeat(600) + " Call me at 415-555-0123.";
  const res = await detector.scan(text);
  assert.ok(res.chunks >= 2, `expected multiple chunks, got ${res.chunks}`);
  const phone = res.spans.find((s) => s.label === "private_phone");
  assert.ok(phone, `no phone at the tail: ${JSON.stringify(res.spans.map((s) => s.label))}`);
  assert.equal(text.slice(phone.start, phone.end), "415-555-0123");
});
