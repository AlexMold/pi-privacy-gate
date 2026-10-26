/**
 * llama-server supervisor + self-managed install (SYSE.24 arrangement A).
 * Downloads platform binary from llama.cpp releases and PII-Tracer-GGUF weights
 * from Hugging Face. Idempotent: reuses anything already present (M0 artifacts
 * or a running server).
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DATA_DIR = process.env.PI_PRIVACY_DIR ?? join(homedir(), ".pi-privacy");
const STATE_FILE = join(DATA_DIR, "state.json");
const HF_REPO = "https://huggingface.co/perplexity-ai/PII-Tracer-GGUF/resolve/main";
const WEIGHT_FILES = [
  "pplx-pii-masking-backbone-f16.gguf",
  "heads.safetensors",
  "pii_head_config.json",
  "tokenizer.json",
];
const DEFAULT_PORT = 18080;

/** Managed llama-server port: privacy-router.json detector.port > PI_PRIVACY_PORT > 18080. */
export function detectorPort(): number {
  try {
    const cfg = JSON.parse(readFileSync(join(DATA_DIR, "privacy-router.json"), "utf8")) as { detector?: { port?: number } };
    const p = cfg.detector?.port;
    if (typeof p === "number" && p > 0 && p < 65536) return p;
  } catch { /* absent/invalid config -> next source */ }
  const env = Number(process.env.PI_PRIVACY_PORT);
  if (env > 0 && env < 65536) return env;
  return DEFAULT_PORT;
}

interface State {
  weightsDir: string;
  binaryPath: string;
  port: number;
  version: string;
  installedAt: string;
}

export function loadState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return null;
  }
}

function saveState(state: State) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function platformAsset(): { asset: string; dest: string } {
  const { platform, arch } = process;
  const map: Record<string, string> = {
    "darwin-arm64": "macos-arm64",
    "darwin-x64": "macos-x64",
    "linux-x64": "ubuntu-x64",
    "linux-arm64": "ubuntu-arm64",
  };
  const key = `${platform}-${arch}`;
  const kind = map[key];
  if (!kind) throw new Error(`unsupported platform ${key} (supported: ${Object.keys(map).join(", ")})`);
  return { asset: `llama-{tag}-bin-${kind}.tar.gz`, dest: `llama-${kind}` };
}

/** Find latest llama.cpp release tag that carries prebuilt binaries (b-tags). */
async function latestBinaryTag(): Promise<string> {
  const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10");
  if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status}`);
  const releases = (await res.json()) as { tag_name: string; assets: { name: string }[] }[];
  for (const rel of releases) {
    if (!rel.tag_name.startsWith("b")) continue;
    if (rel.assets.some((a) => a.name.includes("bin-macos-arm64"))) return rel.tag_name;
  }
  throw new Error("no llama.cpp release with prebuilt binaries found");
}

async function download(url: string, dest: string, sizeHint?: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  if (sizeHint) console.log(`  downloaded ${dest} (${sizeHint})`);
}

/** Download weights + tokenizer + head config from HF (skips files already present). */
export async function ensureWeights(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  for (const f of WEIGHT_FILES) {
    const dest = join(dir, f);
    if (existsSync(dest)) { console.log(`  ${f}: present`); continue; }
    await download(`${HF_REPO}/${f}`, dest, f);
  }
  return dir;
}

/** Download platform llama-server binary (skips if present). Returns binary path. */
export async function ensureBinary(): Promise<{ path: string; tag: string }> {
  const { asset, dest } = platformAsset();
  const binDir = join(DATA_DIR, "bin");
  const binary = join(binDir, "llama-server");
  if (existsSync(binary)) return { path: binary, tag: "cached" };
  const tag = await latestBinaryTag();
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${asset.replace("{tag}", tag)}`;
  const tmp = join(tmpdir(), `llama-${tag}-${dest}.tar.gz`);
  await download(url, tmp, asset);
  mkdirSync(binDir, { recursive: true });
  // BSD tar has no --wildcards and llama-server needs its sibling dylib:
  // extract the whole archive with strip-components=1
  execFileSync("tar", ["-xzf", tmp, "-C", binDir, "--strip-components=1"], { stdio: "inherit" });
  rmSync(tmp, { force: true });
  return { path: binary, tag };
}

/** Run /privacy-setup: weights + binary, then start the server. Idempotent. */
export async function setup(): Promise<State> {
  console.log("pi-privacy: setup");
  const state = loadState();
  const weightsDir = join(DATA_DIR, "model");
  console.log("weights:");
  await ensureWeights(weightsDir);
  console.log("binary:");
  const { path: binaryPath, tag } = await ensureBinary();
  const next: State = state ?? { weightsDir, binaryPath, port: detectorPort(), version: tag, installedAt: new Date().toISOString() };
  next.binaryPath = binaryPath;
  next.port = detectorPort(); // pick up config changes without re-running setup
  if (tag !== "cached") next.version = tag;
  saveState(next);
  await startServer(next);
  return next;
}

let child: ChildProcess | null = null;

/** Start llama-server if not already serving. Returns the port. */
export async function startServer(state: State): Promise<number> {
  const port = detectorPort(); // config change takes effect without re-running /privacy-setup
  state.port = port;
  if (await isHealthy(port)) return port;
  const args = [
    "-m", join(state.weightsDir, "pplx-pii-masking-backbone-f16.gguf"),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--embeddings", "--pooling", "none",
    "-c", "4096", "-b", "4096", "-ub", "4096",
  ];
  child = spawn(state.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  // llama-server is chatty on stderr (one line per slot task per scan). Surface only
  // warnings/errors unless PI_PRIVACY_DEBUG=1.
  // llama-server is chatty on stderr (one line per slot task per scan, plus benign
  // startup warnings). Default: errors only; PI_PRIVACY_DEBUG=1 shows everything.
  const debug = process.env.PI_PRIVACY_DEBUG === "1";
  const recent: string[] = [];
  const forward = (d: Buffer) => {
    const text = d.toString().trim();
    if (!text) return;
    recent.push(text);
    if (recent.length > 20) recent.shift();
    if (!debug && !/\berror\b|\bfatal\b|not loaded/i.test(text)) return;
    console.error(`[llama-server] ${text}`);
  };
  child.stderr?.on("data", forward);
  child.stdout?.on("data", forward);
  // A crash during startup (missing dylib, bad binary) would otherwise be silent:
  // the health wait only reports a timeout, so dump the tail on a non-zero exit.
  child.on("exit", (code) => {
    if (code !== 0 && child) {
      console.error(`[llama-server] exited with code ${code}:`);
      for (const l of recent) console.error(`[llama-server] ${l}`);
    }
  });
  // wait for health, max 30s
  for (let i = 0; i < 60; i++) {
    if (await isHealthy(port)) { saveState(state); return port; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server did not become healthy in 30s");
}

export function stopServer() {
  child?.kill();
  child = null;
}

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Best-effort server startup for session_start: reuse state, fail silently if absent. */
export async function ensureRunning(): Promise<boolean> {
  const state = loadState();
  if (!state) return false;
  try {
    await startServer(state);
    return true;
  } catch (e) {
    console.error(`pi-privacy: server start failed: ${(e as Error).message}`);
    return false;
  }
}
