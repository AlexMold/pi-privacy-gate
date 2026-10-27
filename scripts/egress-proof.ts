/**
 * Egress proof (SPEC E-4): run a real Pi session with the gate ON against a LOCAL
 * provider (Ollama) so nothing can leave the machine even if the gate fails, capture
 * the exact serialized payload of every provider request via before_provider_request,
 * and assert that no raw planted PII appears in any captured payload.
 *
 * Usage: node scripts/egress-proof.ts   (requires: detector installed, ollama running)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REAL_DATA = join(homedir(), ".pi-privacy");
const TMP = join(tmpdir(), `pi-privacy-egress-${process.pid}`);

// Planted PII markers from bench/canary/* (withhold + redact categories)
const MARKERS = [
  "4026-3181-1900-8877",        // account number (bank, isp)
  "support@lumenline.net",      // email (bank)
  "021000021",                  // routing number (bank)
  "BOFAUS3N",                   // SWIFT (bank)
  "221B Baker Street",          // address (isp, ticket)
  "+44 20 7946 0958",           // phone (isp)
  "billing@northmere.net",      // email (isp)
  "Daniel Whitfield",           // person (isp, medical, ticket)
  "1992-03-14",                 // DOB (medical)
  "8877-4412",                  // MRN (medical)
  "Elena Marsh",                // person (medical)
  "NH-2211-88",                 // policy (medical)
  "9012345678",                 // ticket number
  "DC-44X7",                    // plate
  "(202) 555-0199",             // phone (ticket)
];

// 1. temp PI_PRIVACY_DIR: state (weights/binary paths are absolute) + local-provider config
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
cpSync(join(REAL_DATA, "state.json"), join(TMP, "state.json"));
const router = {
  detector: { mode: "managed" },
  localModel: { provider: "ollama", model: "qwen3.6:35b-a3b-q4_K_M" },
  // "Cloud" target: a catalog model that does not exist in the live local Ollama —
  // every request 404s on localhost, but before_provider_request fires first, so the
  // exact outbound payload is captured and nothing ever leaves the machine. (A provider
  // registered from an extension + virtual-model selection crashes pi at startup —
  // pi core bug, worked around here by using an existing catalog entry.)
  cloudModel: { provider: "ollama", model: "gemma4:31b" },
  withholdCategories: ["account_number", "secret", "private_address"],
  redactCategories: ["private_person", "private_email", "private_phone", "private_url", "private_date", "other_pii"],
  retryTimeoutSec: 5,
  spanConfidenceThreshold: 0.5,
  sensitivityThreshold: 0.5,
  allowlist: [],
};
writeFileSync(join(TMP, "privacy-router.json"), JSON.stringify(router, null, 2));

const captureDir = join(TMP, "payloads");
rmSync(captureDir, { recursive: true, force: true });
mkdirSync(captureDir, { recursive: true });

const canaries = readdirSync(join(ROOT, "bench/canary"));
const prompt =
  `Read each of these files and summarize what they contain in one line each: ${canaries
    .map((f) => join(ROOT, "bench/canary", f))
    .join(" ")}`;

// 2. real Pi run: gate ON (pi-privacy/auto), capture extension alongside
const res = spawnSync(
  "pi",
  [
    "-e", ROOT,
    "-e", join(ROOT, "scripts/egress-capture.ts"),
    "--print",
    "-p", prompt,
  ],
  {
    env: { ...process.env, PI_PRIVACY_DIR: TMP, EGRESS_CAPTURE_DIR: captureDir, EGRESS_SELECT: "1" },
    encoding: "utf8",
    timeout: 600_000,
  },
);

console.log("--- pi output (tail) ---");
console.log((res.stdout ?? "").split("\n").slice(-6).join("\n"));
if (res.stderr) console.error((res.stderr).split("\n").filter((l) => l.includes("pi-privacy") || l.includes("error")).slice(-5).join("\n"));

// 3. assert: no marker in any captured payload
const payloads = existsSync(captureDir) ? readdirSync(captureDir).filter((f) => f.endsWith(".json")) : [];
if (payloads.length === 0) {
  console.error("EGRESS PROOF FAILED: no provider payloads captured (before_provider_request did not fire?)");
  process.exit(1);
}
const hits: { marker: string; file: string }[] = [];
for (const f of payloads) {
  const body = readFileSync(join(captureDir, f), "utf8");
  for (const m of MARKERS) {
    if (body.includes(m)) hits.push({ marker: m, file: f });
  }
}

console.log(`\ncaptured ${payloads.length} provider payload(s)`);
if (hits.length > 0) {
  console.error("EGRESS PROOF FAILED — raw PII found in outbound payloads:");
  for (const h of hits) console.error(`  ${h.marker}  in  ${h.file}`);
  process.exit(1);
}
console.log(`checked ${MARKERS.length} planted PII markers across all payloads: none present`);
console.log("EGRESS PROOF PASSED");
