/**
 * Fetch the PII-TRACE benchmark (perplexity-ai/PII-TRACE, MIT) via the datasets-server
 * rows API into bench/piitrace.json. Cached: re-run only when the file is missing.
 */

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = ROOT + "bench/piitrace.json";
const API = "https://datasets-server.huggingface.co/rows?dataset=perplexity-ai%2FPII-TRACE&config=conversations&split=train";

if (existsSync(OUT)) {
  console.log(`cached: ${OUT}`);
  process.exit(0);
}

interface Row {
  row: {
    id: string;
    turns: { turn: number; user: string; assistant: string }[];
    spans: { label: string; turn: number; source: string; start: number; end: number; text: string }[];
  };
}

const rows: Row["row"][] = [];
for (let offset = 0; offset < 500; offset += 100) {
  const res = await fetch(`${API}&offset=${offset}&length=100`);
  if (!res.ok) throw new Error(`datasets-server HTTP ${res.status}`);
  const data = (await res.json()) as { rows: Row[] };
  rows.push(...data.rows.map((r) => r.row));
  console.log(`fetched ${rows.length} conversations`);
}

writeFileSync(OUT, JSON.stringify(rows));
console.log(`saved ${rows.length} conversations to ${OUT}`);
void readFileSync;
