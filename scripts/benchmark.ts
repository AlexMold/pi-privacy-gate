/**
 * M6 benchmark (SPEC E-2): run the detector over PII-TRACE and compute
 * micro exact typed-span P/R/F1 over (turn, source, start, end, label)
 * plus untyped F1. Requires llama-server with PII-Tracer-GGUF.
 *
 * Fairness: gold spans are whitespace-trimmed on both sides, matching the
 * detector's own span stripping (the count of trimmed gold spans is reported).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PiiDetector } from "../src/detector.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = ROOT + "bench/piitrace.json";
const OUT = ROOT + "bench/piitrace-report.md";
const MODEL_DIR = process.env.PII_TEST_MODEL_DIR ?? ROOT + "spike/";
const SERVER = process.env.PII_TEST_SERVER ?? "http://127.0.0.1:8080";

if (!existsSync(DATA)) {
  console.error("run scripts/fetch-piitrace.ts first");
  process.exit(1);
}

interface Conversation {
  id: string;
  turns: { turn: number; user: string; assistant: string }[];
  spans: { label: string; turn: number; source: string; start: number; end: number; text: string }[];
}

const convs = JSON.parse(readFileSync(DATA, "utf8")) as Conversation[];
const detector = new PiiDetector(MODEL_DIR, SERVER);

const trim = (t: string, s: number, e: number): [number, number] => {
  while (s < e && " \t\n".includes(t[s])) s++;
  while (e > s && " \t\n".includes(t[e - 1])) e--;
  return [s, e];
};

interface Sp { label: string; start: number; end: number; }
const pred = new Map<string, Sp[]>(); // key: `${id}:${turn}:${source}`
let trimmedGold = 0;

for (const c of convs) {
  for (const turn of c.turns) {
    for (const source of ["user", "assistant"] as const) {
      const text: string = turn[source];
      const res = await detector.scan(text);
      pred.set(`${c.id}:${turn.turn}:${source}`, res.spans.map((s) => ({ label: s.label, start: s.start, end: s.end })));
      for (const g of c.spans.filter((g) => g.turn === turn.turn && g.source === source)) {
        const [ns, ne] = trim(text, g.start, g.end);
        if (ns !== g.start || ne !== g.end) trimmedGold++;
      }
    }
  }
}

let tp = 0, fp = 0, fn = 0;
let tpUntyped = 0, fnUntyped = 0;
const perLabel: Record<string, { tp: number; fp: number; fn: number }> = {};

for (const c of convs) {
  for (const g of c.spans) {
    const key = `${c.id}:${g.turn}:${g.source}`;
    const text = c.turns.find((t) => t.turn === g.turn)![g.source];
    const [ns, ne] = trim(text, g.start, g.end);
    const preds = pred.get(key) ?? [];
    const match = preds.find((p) => p.label === g.label && p.start === ns && p.end === ne);
    const matchUntyped = preds.find((p) => p.start === ns && p.end === ne);
    if (match) { tp++; (perLabel[g.label] ??= { tp: 0, fp: 0, fn: 0 }).tp++; }
    else { fn++; (perLabel[g.label] ??= { tp: 0, fp: 0, fn: 0 }).fn++; }
    if (matchUntyped) tpUntyped++; else fnUntyped++;
  }
  // FPs: predicted spans not matching any gold in that message
  for (const [key, preds] of pred) {
    const [id, turnS, source] = key.split(":");
    if (id !== c.id) continue;
    const turn = Number(turnS);
    const text = c.turns.find((t) => t.turn === turn)![source as "user" | "assistant"];
    const golds = c.spans
      .filter((g) => g.turn === turn && g.source === source)
      .map((g) => ({ label: g.label, ...(function () { const [ns, ne] = trim(text, g.start, g.end); return { ns, ne }; })() }));
    for (const p of preds) {
      const isGold = golds.some((g) => g.label === p.label && g.ns === p.start && g.ne === p.end);
      if (!isGold) { fp++; (perLabel[p.label] ??= { tp: 0, fp: 0, fn: 0 }).fp++; }
    }
  }
}

const f1 = (t: number, fpCount: number, fnCount: number) => (2 * t + fpCount + fnCount === 0 ? 0 : (2 * t) / (2 * t + fpCount + fnCount));
const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);
const pUntyped = tpUntyped / (tpUntyped + fp || 1);
const rUntyped = tpUntyped / (tpUntyped + fnUntyped || 1);
const f1Typed = f1(tp, fp, fn);
const f1Untyped = f1(tpUntyped, fp, fnUntyped);

const lines: string[] = [
  `# PII-TRACE benchmark — ${new Date().toISOString().slice(0, 10)}`,
  "",
  `Detector: PII-Tracer-GGUF f16, window 1024 tokens, spanConfidenceThreshold 0.5.`,
  `Conversations: ${convs.length}. Gold spans: ${tp + fn}. Whitespace-trimmed gold spans: ${trimmedGold}.`,
  "",
  "## Micro, exact typed-span (turn, source, start, end, label)",
  "",
  `| Metric | Value |`,
  `|--------|-------|`,
  `| Precision | ${(precision * 100).toFixed(1)}% |`,
  `| Recall | ${(recall * 100).toFixed(1)}% |`,
  `| F1 | ${(f1Typed * 100).toFixed(1)}% |`,
  `| F1 untyped (exact bounds) | ${(f1Untyped * 100).toFixed(1)}% |`,
  "",
  "## Per label (typed, micro)",
  "",
  "| Label | TP | FP | FN |",
  "|-------|----|----|----|",
  ...Object.entries(perLabel).sort((a, b) => b[1].tp - a[1].tp).map(([l, v]) => `| ${l} | ${v.tp} | ${v.fp} | ${v.fn} |`),
];

writeFileSync(OUT, lines.join("\n"));
console.log(lines.join("\n"));
