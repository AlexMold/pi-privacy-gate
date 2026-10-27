import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { Qwen3Bpe, chunkText } from "../src/tokenizer.ts";

const SPIKE = fileURLToPath(new URL("../spike/", import.meta.url));
const MODEL_DIR = process.env.PII_TEST_MODEL_DIR ??
  (existsSync(join(homedir(), ".pi-privacy", "model", "tokenizer.json"))
    ? join(homedir(), ".pi-privacy", "model")
    : SPIKE);
const bpe = Qwen3Bpe.fromTokenizerJson(JSON.parse(readFileSync(MODEL_DIR + "/tokenizer.json", "utf8")));

const CANONICAL = "Hi, I'm Daniel Whitfield, you can reach me at daniels@meridiancap.com or 415-555-0123.";
// golden ids from llama-server /tokenize (spike REPORT.md)
const GOLDEN_IDS = [13048, 11, 358, 2776, 15118, 26386, 2566, 11, 498, 646, 5545, 752, 518, 294, 5559, 2010, 31, 1174, 35642, 11346, 905, 476, 220, 19, 16, 20, 12, 20, 20, 20, 12, 15, 16, 17, 18, 13];

test("byte-exact tokenization vs llama-server golden", () => {
  const { ids } = bpe.encode(CANONICAL);
  assert.deepEqual(ids, GOLDEN_IDS);
});

test("char offsets on canonical text", () => {
  const { ids, byteStarts, byteEnds } = bpe.encode(CANONICAL);
  const chars = ids.map((_, i) => [Qwen3Bpe.byteToCharOffset(CANONICAL, byteStarts[i]), Qwen3Bpe.byteToCharOffset(CANONICAL, byteEnds[i])]);
  assert.deepEqual(chars[0], [0, 2]); // "Hi"
  assert.deepEqual(chars[1], [2, 3]); // ","
  // gap-free, monotonic, full coverage
  assert.equal(chars.map(([s, e]) => CANONICAL.slice(s, e)).join(""), CANONICAL);
  for (let i = 1; i < chars.length; i++) {
    assert.ok(chars[i][0] >= chars[i - 1][1], `overlap/gap at token ${i}`);
  }
});

test("cyrillic multi-byte offsets", () => {
  const text = "Привет, меня зовут Александр Грибков";
  const { ids, byteStarts, byteEnds } = bpe.encode(text);
  const chars = ids.map((_, i) => [Qwen3Bpe.byteToCharOffset(text, byteStarts[i]), Qwen3Bpe.byteToCharOffset(text, byteEnds[i])]);
  // gap-free reconstruction over multi-byte chars
  assert.equal(chars.map(([s, e]) => text.slice(s, e)).join(""), text);
  // "Александр Грибков" covered by consecutive tokens (trim partial boundary tokens)
  const nameStart = text.indexOf("Александр");
  const nameEnd = nameStart + "Александр Грибков".length;
  const cover = chars.filter(([s, e]) => e > nameStart && s < nameEnd)
    .map(([s, e]) => text.slice(Math.max(s, nameStart), Math.min(e, nameEnd)));
  assert.equal(cover.join(""), "Александр Грибков");
});

test("chunkText splits at token boundaries and covers the text", () => {
  const words = "expenses invoice meeting schedule budget analysis notes summary review update ";
  const text = words.repeat(600); // ~22K chars, >4096 tokens
  const chunks = chunkText(bpe, text, 4096);
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  assert.equal(chunks.map((c) => c.text).join(""), text);
  for (const c of chunks) {
    const { ids } = bpe.encode(c.text);
    assert.ok(ids.length <= 4096, `chunk has ${ids.length} tokens`);
  }
});
