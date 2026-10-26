/**
 * Qwen3 byte-level BPE tokenizer with byte→char offset mapping.
 * Port of the PII-Tracer-GGUF client tokenization, verified byte-exact
 * against llama-server /tokenize (spike REPORT.md).
 */

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

export interface TokenizerData {
  merges: string[][];
  vocab: Record<string, number>;
}

export class Qwen3Bpe {
  private ranks = new Map<string, number>();
  private tokenId = new Map<string, number>();

  constructor(data: TokenizerData) {
    data.merges.forEach(([a, b], rank) => this.ranks.set(a + b, rank));
    for (const [tok, id] of Object.entries(data.vocab)) this.tokenId.set(tok, id);
  }

  static fromTokenizerJson(json: unknown): Qwen3Bpe {
    const model = (json as { model: TokenizerData }).model;
    return new Qwen3Bpe(model);
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
      const chunkBytes = new TextEncoder().encode(m[0]);
      const syms = Array.from(chunkBytes, (b) => BYTE_ENC[b]);
      for (const tok of this.bpeChunk(syms)) {
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

/**
 * Split text into chunks of at most maxTokens tokens, at token boundaries.
 * Returns char ranges [start, end) per chunk.
 */
export function chunkText(
  bpe: Qwen3Bpe,
  text: string,
  maxTokens = 4096,
): { text: string; charStart: number; charEnd: number }[] {
  const { ids, byteStarts, byteEnds } = bpe.encode(text);
  const chunks: { text: string; charStart: number; charEnd: number }[] = [];
  let startTok = 0;
  while (startTok < ids.length) {
    let endTok = Math.min(startTok + maxTokens, ids.length);
    const charStart = Qwen3Bpe.byteToCharOffset(text, byteStarts[startTok]);
    const charEnd = Qwen3Bpe.byteToCharOffset(text, byteEnds[endTok - 1]);
    chunks.push({ text: text.slice(charStart, charEnd), charStart, charEnd });
    startTok = endTok;
  }
  return chunks;
}
