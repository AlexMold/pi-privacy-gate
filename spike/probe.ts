/**
 * M0 spike probe: PII-Tracer-GGUF detection pipeline in pure TS, no deps.
 *
 *   node spike/probe.ts tokenize "text"   -> token ids + char offsets (vs llama-server /tokenize)
 *   node spike/probe.ts detect "text"     -> /embeddings -> heads -> Viterbi -> spans + timing
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SERVER = "http://127.0.0.1:8080";
const SPIKE = new URL(".", import.meta.url).pathname;

// ------------------------------------------------------------------ byte-level BPE

// GPT2 pattern with (?i:) expanded (JS has no inline flag groups). Ordered alternation as in HF.
const GPT2_PATTERN =
  /'(?:[sS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD])|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

// byte -> unicode char (GPT2 byte encoder): 33..126, 161..172, 174..255 -> self; rest -> 256+n in byte order
const BYTE_ENC: number[] = (() => {
  const keep = new Set<number>();
  for (let b = 33; b <= 126; b++) keep.add(b);
  for (let b = 161; b <= 172; b++) keep.add(b);
  for (let b = 174; b <= 255; b++) keep.add(b);
  const enc: number[] = [];
  let n = 0;
  for (let b = 0; b < 256; b++) enc.push(keep.has(b) ? b : 256 + n++);
  return enc;
})();
const BYTE_DEC = new Map<number, number>(BYTE_ENC.map((v, b) => [v, b]));

class Qwen3Bpe {
  private ranks = new Map<string, number>();
  private tokenId = new Map<string, number>();
  private idToToken = new Map<number, string>();

  constructor(merges: string[][], vocab: Record<string, number>) {
    merges.forEach(([a, b], rank) => this.ranks.set(a + b, rank));
    for (const [tok, id] of Object.entries(vocab)) {
      this.tokenId.set(tok, id);
      this.idToToken.set(id, tok);
    }
  }

  /** Greedy BPE on one regex chunk (bytelevel symbols). Returns token strings. */
  private bpeChunk(syms: number[]): string[] {
    const parts = syms.map((c) => String.fromCharCode(c));
    for (;;) {
      let bestRank = Infinity, bestIdx = -1;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i] + parts[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; bestIdx = i; }
      }
      if (bestIdx < 0) return parts;
      parts.splice(bestIdx, 2, parts[bestIdx] + parts[bestIdx + 1]);
    }
  }

  /** Encode text -> token ids + byte offsets per token. */
  encode(text: string): { ids: number[]; byteStarts: number[]; byteEnds: number[] } {
    const ids: number[] = [];
    const byteStarts: number[] = [];
    const byteEnds: number[] = [];
    let bytePos = 0;
    for (const m of text.matchAll(GPT2_PATTERN)) {
      const chunkStr = m[0];
      const chunkBytes = new TextEncoder().encode(chunkStr);
      const syms = Array.from(chunkBytes, (b) => BYTE_ENC[b]);
      const tokens = this.bpeChunk(syms);
      for (const tok of tokens) {
        const id = this.tokenId.get(tok);
        if (id === undefined) throw new Error(`token ${JSON.stringify(tok)} not in vocab`);
        // every bytelevel vocab char maps to exactly one byte
        const len = tok.length;
        ids.push(id);
        byteStarts.push(bytePos);
        byteEnds.push(bytePos + len);
        bytePos += len;
      }
    }
    return { ids, byteStarts, byteEnds };
  }

  /** Convert byte offset -> char (codepoint) offset given the original text. */
  static byteToCharOffset(text: string, byteOff: number): number {
    const bytes = new TextEncoder().encode(text);
    let char = 0;
    for (let i = 0; i < byteOff && i < bytes.length; i++) {
      if ((bytes[i] & 0xc0) !== 0x80) char++;
    }
    return char;
  }
}

// ------------------------------------------------------------- safetensors (tiny)

function readSafetensors(path: string): Map<string, Float32Array> {
  const buf = readFileSync(path);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString());
  const out = new Map<string, Float32Array>();
  let off = 8 + headerLen;
  for (const [name, info] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const { data_offsets, dtype } = info as { data_offsets: number[]; dtype: string };
    if (dtype !== "F32") throw new Error(`unsupported dtype ${dtype} for ${name}`);
    const [start, end] = data_offsets;
    const f32 = new Float32Array(buf.subarray(off + start, off + end).buffer.slice(buf.byteOffset + off + start, buf.byteOffset + off + end));
    out.set(name, f32);
  }
  return out;
}

// ----------------------------------------------------------------------- Viterbi

const cfg = JSON.parse(readFileSync(SPIKE + "pii_head_config.json", "utf8"));
const LABELS: string[] = cfg.labels;
const labelId = new Map<string, number>(LABELS.map((l: string, i: number) => [l, i]));
const B_BIAS: number = cfg.viterbi_b_bias, E_BIAS: number = cfg.viterbi_e_bias;
const PII_TYPES: string[] = LABELS.filter((l: string) => l.startsWith("S-")).map((l: string) => l.slice(2));

function decodeSpans(logits: number[][], charOffsets: [number, number][], text: string): { start: number; end: number; label: string; score: number }[] {
  const T = logits.length, C = LABELS.length;
  const l2i = labelId;
  // transition mask
  const trans: number[][] = Array.from({ length: C }, () => new Array(C).fill(-Infinity));
  const endStates = new Set([l2i.get("O")!]);
  const beginStates = new Set([l2i.get("O")!]);
  for (const t of PII_TYPES) {
    const b = l2i.get(`B-${t}`)!, i = l2i.get(`I-${t}`)!, e = l2i.get(`E-${t}`)!, s = l2i.get(`S-${t}`)!;
    endStates.add(e); endStates.add(s); beginStates.add(b); beginStates.add(s);
    trans[b][i] = 0; trans[b][e] = 0; trans[i][i] = 0; trans[i][e] = 0;
  }
  for (const from of endStates) for (const to of beginStates) trans[from][to] = 0;
  for (const t of PII_TYPES) {
    const b = l2i.get(`B-${t}`)!, e = l2i.get(`E-${t}`)!;
    for (let from = 0; from < C; from++) if (trans[from][b] > -Infinity) trans[from][b] += B_BIAS;
    for (let to = 0; to < C; to++) if (trans[e][to] > -Infinity) trans[e][to] += E_BIAS;
  }
  // viterbi
  const score = Array.from({ length: T }, () => new Array(C).fill(-Infinity));
  const back = Array.from({ length: T }, () => new Int32Array(C));
  for (let c = 0; c < C; c++) {
    const l = LABELS[c];
    if (l === "O" || l.startsWith("B-") || l.startsWith("S-")) score[0][c] = logits[0][c];
  }
  for (let t = 1; t < T; t++) {
    for (let c = 0; c < C; c++) {
      let best = -Infinity, bestPrev = 0;
      for (let p = 0; p < C; p++) {
        const v = score[t - 1][p] + trans[p][c];
        if (v > best) { best = v; bestPrev = p; }
      }
      score[t][c] = logits[t][c] + best;
      back[t][c] = bestPrev;
    }
  }
  let bestLast = 0, bestLastScore = -Infinity;
  for (let c = 0; c < C; c++) {
    const l = LABELS[c];
    if (l === "O" || l.startsWith("E-") || l.startsWith("S-")) {
      if (score[T - 1][c] > bestLastScore) { bestLastScore = score[T - 1][c]; bestLast = c; }
    }
  }
  const path: number[] = [bestLast];
  for (let t = T - 1; t > 0; t--) path.unshift(back[t][path[0]]);
  // path -> spans
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const spans: { start: number; end: number; label: string; score: number }[] = [];
  let t = 0;
  while (t < T) {
    const label = LABELS[path[t]];
    const [cs, ce] = charOffsets[t];
    if (label.startsWith("S-")) {
      if (cs < ce) spans.push({ start: cs, end: ce, label: label.slice(2), score: sig(logits[t][path[t]]) });
      t++;
    } else if (label.startsWith("B-")) {
      const type = label.slice(2);
      let s = cs, e = ce;
      const scores: number[] = [logits[t][path[t]]];
      t++;
      while (t < T) {
        const inner = LABELS[path[t]];
        if (inner === `I-${type}`) { e = charOffsets[t][1]; scores.push(logits[t][path[t]]); t++; }
        else if (inner === `E-${type}`) { e = charOffsets[t][1]; scores.push(logits[t][path[t]]); t++; break; }
        else break;
      }
      if (s < e) spans.push({ start: s, end: e, label: type, score: sig(scores.reduce((a, b) => a + b, 0) / scores.length) });
    } else t++;
  }
  // strip whitespace
  const out: { start: number; end: number; label: string; score: number }[] = [];
  for (const s of spans) {
    let ns = s.start, ne = s.end;
    while (ns < ne && " \t\n".includes(text[ns])) ns++;
    while (ne > ns && " \t\n".includes(text[ne - 1])) ne--;
    if (ns < ne) out.push({ start: ns, end: ne, label: s.label, score: s.score });
  }
  return out;
}

// ------------------------------------------------------------------------- main

const [mode, ...rest] = process.argv.slice(2);
const text = rest.join(" ");

if (!text) { console.error("usage: probe.ts tokenize|detect \"text\""); process.exit(1); }

const tokJson = JSON.parse(readFileSync(SPIKE + "tokenizer.json", "utf8"));
const bpe = new Qwen3Bpe(tokJson.model.merges as string[][], tokJson.model.vocab as Record<string, number>);

if (mode === "tokenize") {
  const { ids, byteStarts, byteEnds } = bpe.encode(text);
  const chars = ids.map((id, i) => [Qwen3Bpe.byteToCharOffset(text, byteStarts[i]), Qwen3Bpe.byteToCharOffset(text, byteEnds[i])]);
  console.log("ids:", ids.join(","));
  console.log("offsets:", chars.map((c) => `${c[0]}:${c[1]}`).join(" "));
} else if (mode === "detect") {
  const t0 = performance.now();
  const { ids, byteStarts, byteEnds } = bpe.encode(text);
  const tTok = performance.now();
  const resp = await fetch(`${SERVER}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!resp.ok) { console.error("embeddings HTTP", resp.status, await resp.text()); process.exit(1); }
  const embResp = await resp.json();
  const nested = embResp[0].embedding as number[][];
  const T = nested.length;
  const emb = nested.flat();
  const tEmb = performance.now();
  if (T !== ids.length) {
    console.error(`TOKENIZATION MISMATCH: server=${T} local=${ids.length}`);
  }
  const heads = readSafetensors(SPIKE + "heads.safetensors");
  const W = heads.get("token_cls_head.weight")!;
  const b = heads.get("token_cls_head.bias")!;
  const Wsen = heads.get("sensitivity_head.weight")!;
  const bsen = heads.get("sensitivity_head.bias")!;
  const logits: number[][] = [];
  let mean = new Array(1024).fill(0);
  for (let t = 0; t < T; t++) {
    const row: number[] = new Array(37);
    for (let c = 0; c < 37; c++) {
      let v = b[c];
      const w0 = c * 1024;
      for (let d = 0; d < 1024; d++) v += emb[t * 1024 + d] * W[w0 + d];
      row[c] = v;
    }
    logits.push(row);
    for (let d = 0; d < 1024; d++) mean[d] += emb[t * 1024 + d];
  }
  let sens = bsen[0];
  for (let d = 0; d < 1024; d++) sens += (mean[d] / T) * Wsen[d];
  sens = 1 / (1 + Math.exp(-sens));
  const chars = ids.map((_, i): [number, number] => [Qwen3Bpe.byteToCharOffset(text, byteStarts[i]), Qwen3Bpe.byteToCharOffset(text, byteEnds[i])]);
  const spans = decodeSpans(logits, chars, text);
  const tDone = performance.now();
  let masked = text;
  for (const s of spans.sort((a, b) => b.start - a.start)) {
    masked = masked.slice(0, s.start) + `[${s.label.toUpperCase()}]` + masked.slice(s.end);
  }
  console.log(`sensitivity: ${sens.toFixed(3)}`);
  for (const s of spans) console.log(`  ${s.label.padEnd(18)} [${s.start}:${s.end}] ${JSON.stringify(text.slice(s.start, s.end))} score=${s.score.toFixed(3)}`);
  console.log(masked);
  console.log(`timing: tokenize=${(tTok - t0).toFixed(1)}ms embed_request=${(tEmb - tTok).toFixed(1)}ms heads+viterbi=${(tDone - tEmb).toFixed(1)}ms`);
} else {
  console.error("unknown mode");
  process.exit(1);
}
