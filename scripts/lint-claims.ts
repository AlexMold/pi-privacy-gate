/**
 * M6 Claim Register lint: gate-behavior test files must cite at least one
 * L/A/D/E claim ID from SPEC.md, and every cited ID must exist in SPEC.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPEC = readFileSync(ROOT + "SPEC.md", "utf8");

// test files that check boundary claims (mechanism tests like tokenizer/viterbi are exempt)
const GATE_TEST_FILES = ["gate.test.ts", "gate-retry.test.ts", "analyze.test.ts", "config.test.ts", "canary.test.ts"];
const ID_RE = /\b[LADE]-\d+\b/g;

let failures = 0;
for (const f of GATE_TEST_FILES) {
  const src = readFileSync(ROOT + "test/" + f, "utf8");
  const ids = [...src.matchAll(ID_RE)].map((m) => m[0]);
  if (ids.length === 0) {
    console.error(`FAIL ${f}: no Claim Register ID cited`);
    failures++;
  }
  for (const id of ids) {
    if (!SPEC.includes(`| ${id} |`)) {
      console.error(`FAIL ${f}: ID ${id} not found in SPEC.md Claim Register`);
      failures++;
    }
  }
}

// every ID in SPEC.md Claim Register table is well-formed
const tableIds = [...SPEC.matchAll(/^\| (L-\d+|A-\d+|D-\d+|E-\d+) \|/gm)].map((m) => m[1]);
console.log(`Claim Register has ${tableIds.length} claims: ${tableIds.join(", ")}`);

if (failures > 0) {
  console.error(`${failures} claim-lint failure(s)`);
  process.exit(1);
}
console.log("claim lint: OK");
