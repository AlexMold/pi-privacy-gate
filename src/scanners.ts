/**
 * Detector backends other than the managed llama-server (SPEC design tree #4).
 *
 * Contract: given text, return PII spans.
 *   { "spans": [{ "start": 0, "end": 24, "label": "private_person", "score": 0.99 }] }
 * `start`/`end` are char offsets in the submitted text; `score` is optional (defaults to 1).
 *
 * Two transports:
 *   http    — POST {"text": "..."} to `detector.url`, JSON response as above
 *   command — run `detector.command`, the text arrives on stdin, stdout must be the JSON
 *
 * Anything that can answer in that shape works: the PII-Tracer vLLM scoring adapter,
 * a Python transformers wrapper, an MLX script, a remote detector service.
 */

import { spawn } from "node:child_process";
import type { PredictedSpan } from "./viterbi.ts";

export interface SpanScanner {
  scan(text: string): Promise<{ spans: PredictedSpan[] }>;
}

export type DetectorConfig =
  | { mode: "managed"; port?: number }
  | { mode: "http"; url: string; timeoutMs?: number }
  | { mode: "command"; command: string; timeoutMs?: number };

const LABEL_RE = /^[a-z_]{1,40}$/;

/**
 * Trust boundary: spans arrive from an external process/service, so bounds, ordering,
 * and label shape are validated here. Invalid spans are dropped, not trusted.
 */
export function validateSpans(raw: unknown, textLength: number): PredictedSpan[] {
  if (!Array.isArray(raw)) throw new Error("detector response: `spans` must be an array");
  const out: PredictedSpan[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { start, end, label, score } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (typeof label !== "string" || !LABEL_RE.test(label)) continue;
    const s = Math.max(0, Math.floor(start));
    const e = Math.min(textLength, Math.floor(end));
    if (e <= s) continue;
    const sc = typeof score === "number" && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 1;
    out.push({ start: s, end: e, label, score: sc });
  }
  return out;
}

function parseResponse(body: string, textLength: number): { spans: PredictedSpan[] } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`detector response is not JSON: ${body.slice(0, 200)}`);
  }
  const spans = (json as { spans?: unknown }).spans;
  return { spans: validateSpans(spans, textLength) };
}

export class HttpScanner implements SpanScanner {
  private url: string;
  private timeoutMs: number;

  constructor(url: string, timeoutMs = 60_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async scan(text: string): Promise<{ spans: PredictedSpan[] }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`detector HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return parseResponse(await res.text(), text.length);
  }
}

export class CommandScanner implements SpanScanner {
  private command: string;
  private timeoutMs: number;

  constructor(command: string, timeoutMs = 120_000) {
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  scan(text: string): Promise<{ spans: PredictedSpan[] }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`detector command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`detector command failed to start: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stderr = Buffer.concat(err).toString().trim();
        if (code !== 0) {
          reject(new Error(`detector command exited ${code}: ${stderr.slice(0, 300)}`));
          return;
        }
        try {
          resolve(parseResponse(Buffer.concat(out).toString(), text.length));
        } catch (e) {
          reject(new Error(`${(e as Error).message}${stderr ? ` (stderr: ${stderr.slice(0, 200)})` : ""}`));
        }
      });
      child.stdin.on("error", () => { /* command may not read stdin */ });
      child.stdin.end(text);
    });
  }
}
