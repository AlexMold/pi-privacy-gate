import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSpans, maskText, type HeadConfig } from "../src/viterbi.ts";

const CFG: HeadConfig = {
  labels: ["O", "B-private_person", "I-private_person", "E-private_person", "S-private_person"],
  num_token_labels: 5,
  hidden_size: 1024,
  viterbi_b_bias: 0,
  viterbi_e_bias: 0,
};

test("decodes B-I-E span from synthetic logits", () => {
  const logits = [
    [10, -10, -10, -10, -10], // O
    [-10, 10, -10, -10, -10], // B-person
    [-10, -10, 10, -10, -10], // I-person
    [-10, -10, -10, 10, -10], // E-person
    [10, -10, -10, -10, -10], // O
  ];
  const offsets: [number, number][] = [[0, 1], [1, 4], [4, 7], [7, 10], [10, 11]];
  const text = "aJohnb";
  const spans = decodeSpans(logits, offsets, text, CFG);
  assert.equal(spans.length, 1);
  assert.deepEqual(
    { start: spans[0].start, end: spans[0].end, label: spans[0].label },
    { start: 1, end: 10, label: "private_person" },
  );
  assert.ok(spans[0].score > 0.99, `score ${spans[0].score}`);
});

test("decodes S span and strips whitespace", () => {
  const logits = [
    [10, -10, -10, -10, -10], // O
    [-10, -10, -10, -10, 10], // S-person
    [10, -10, -10, -10, -10], // O
  ];
  const offsets: [number, number][] = [[0, 2], [2, 8], [8, 9]];
  const text = "a  John b";
  const spans = decodeSpans(logits, offsets, text, CFG);
  assert.equal(spans.length, 1);
  assert.deepEqual({ start: spans[0].start, end: spans[0].end }, { start: 3, end: 7 });
});

test("no spans on all-O path", () => {
  const logits = [[10, -10, -10, -10, -10], [10, -10, -10, -10, -10]];
  const offsets: [number, number][] = [[0, 2], [2, 4]];
  assert.deepEqual(decodeSpans(logits, offsets, "abcd", CFG), []);
});

test("maskText replaces spans with category tags", () => {
  const text = "Hi, I'm Daniel Whitfield";
  const masked = maskText(text, [{ start: 8, end: 24, label: "private_person", score: 1 }]);
  assert.equal(masked, "Hi, I'm [REDACTED_PRIVATE_PERSON]");
});
