/**
 * PiiDetector — scan API: text -> PII spans + sensitivity, via llama-server.
 * Pure TS: BPE tokenizer, heads matmul, constrained BIOES Viterbi (spike REPORT.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Qwen3Bpe, chunkText } from "./tokenizer.ts";
import { readSafetensors } from "./safetensors.ts";
import { decodeSpans, type PredictedSpan, type HeadConfig } from "./viterbi.ts";

// 1024: the model misses PII near the tail of long chunks (spike: reliable at
// <=~1400 tokens before the span, misses at ~1600+; repetitive text degrades faster).
// No overlap needed: any span is at most 1023 tokens from a window start.
const MAX_TOKENS = 1024;
const HIDDEN = 1024;

export interface ScanResult {
  spans: PredictedSpan[];
  sensitivity: number;
  chunks: number;
  ms: { tokenize: number; embed: number };
}

export class PiiDetector {
  private bpe: Qwen3Bpe;
  private cfg: HeadConfig;
  private W: Float32Array; // [37, 1024]
  private b: Float32Array; // [37]
  private Wsen: Float32Array; // [1, 1024]
  private bsen: Float32Array; // [1]
  private modelDir: string;
  private serverUrl: string;

  constructor(
    modelDir: string,
    serverUrl = "http://127.0.0.1:8080",
  ) {
    this.modelDir = modelDir;
    this.serverUrl = serverUrl;
    const tokJson = JSON.parse(readFileSync(join(modelDir, "tokenizer.json"), "utf8"));
    this.bpe = Qwen3Bpe.fromTokenizerJson(tokJson);
    this.cfg = JSON.parse(readFileSync(join(modelDir, "pii_head_config.json"), "utf8")) as HeadConfig;
    const heads = readSafetensors(join(modelDir, "heads.safetensors"));
    this.W = heads.get("token_cls_head.weight")!;
    this.b = heads.get("token_cls_head.bias")!;
    this.Wsen = heads.get("sensitivity_head.weight")!;
    this.bsen = heads.get("sensitivity_head.bias")!;
    if (this.cfg.hidden_size !== HIDDEN) throw new Error(`unexpected hidden_size ${this.cfg.hidden_size}`);
  }

  /** Scan full text (chunked at 4096 tokens). Spans carry absolute char offsets. */
  async scan(text: string): Promise<ScanResult> {
    const t0 = performance.now();
    const chunks = chunkText(this.bpe, text, MAX_TOKENS);
    const tTok = performance.now();
    const spans: PredictedSpan[] = [];
    let sensSum = 0;
    for (const chunk of chunks) {
      const resp = await fetch(`${this.serverUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk.text }),
      });
      if (!resp.ok) throw new Error(`llama-server /embeddings HTTP ${resp.status}: ${await resp.text()}`);
      const nested = ((await resp.json()) as { index: number; embedding: number[][] }[])[0].embedding;
      const T = nested.length;
      const emb = nested.flat();
      if (T > MAX_TOKENS) throw new Error(`server returned ${T} tokens (ctx too small)`);
      const { ids, byteStarts, byteEnds } = this.bpe.encode(chunk.text);
      if (ids.length !== T) throw new Error(`tokenization mismatch: server=${T} local=${ids.length}`);
      const logits: number[][] = [];
      const mean = new Array(HIDDEN).fill(0);
      for (let t = 0; t < T; t++) {
        const row: number[] = new Array(37);
        for (let c = 0; c < 37; c++) {
          let v = this.b[c];
          const w0 = c * HIDDEN;
          for (let d = 0; d < HIDDEN; d++) v += emb[t * HIDDEN + d] * this.W[w0 + d];
          row[c] = v;
        }
        logits.push(row);
        for (let d = 0; d < HIDDEN; d++) mean[d] += emb[t * HIDDEN + d];
      }
      let sens = this.bsen[0];
      for (let d = 0; d < HIDDEN; d++) sens += (mean[d] / T) * this.Wsen[d];
      sensSum += 1 / (1 + Math.exp(-sens));
      const chars = ids.map((_, i): [number, number] => [
        chunk.charStart + Qwen3Bpe.byteToCharOffset(chunk.text, byteStarts[i]),
        chunk.charStart + Qwen3Bpe.byteToCharOffset(chunk.text, byteEnds[i]),
      ]);
      for (const s of decodeSpans(logits, chars, chunk.text, this.cfg)) spans.push(s);
    }
    const tDone = performance.now();
    return {
      spans,
      sensitivity: chunks.length ? sensSum / chunks.length : 0,
      chunks: chunks.length,
      ms: { tokenize: tTok - t0, embed: tDone - tTok },
    };
  }
}
