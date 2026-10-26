/**
 * Constrained BIOES Viterbi decoder — port of the PII-Tracer-GGUF client.
 */

export interface PredictedSpan {
  start: number; // char offset in document text
  end: number;
  label: string; // e.g. "private_person"
  score: number;
}

export interface HeadConfig {
  labels: string[];
  num_token_labels: number;
  hidden_size: number;
  viterbi_b_bias: number;
  viterbi_e_bias: number;
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));

export function decodeSpans(
  logits: number[][],
  charOffsets: [number, number][],
  text: string,
  cfg: HeadConfig,
): PredictedSpan[] {
  const LABELS = cfg.labels;
  const T = logits.length, C = LABELS.length;
  const l2i = new Map<string, number>(LABELS.map((l, i) => [l, i]));
  const PII_TYPES = LABELS.filter((l) => l.startsWith("S-")).map((l) => l.slice(2));
  const B_BIAS = cfg.viterbi_b_bias, E_BIAS = cfg.viterbi_e_bias;

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
  const spans: PredictedSpan[] = [];
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
  const out: PredictedSpan[] = [];
  for (const s of spans) {
    let ns = s.start, ne = s.end;
    while (ns < ne && " \t\n".includes(text[ns])) ns++;
    while (ne > ns && " \t\n".includes(text[ne - 1])) ne--;
    if (ns < ne) out.push({ start: ns, end: ne, label: s.label, score: s.score });
  }
  return out;
}

export function maskText(text: string, spans: PredictedSpan[]): string {
  let masked = text;
  // SPEC A-2 format: [REDACTED_category]. The bare [CATEGORY] form self-triggers
  // the detector (dogfooding finding 2026-10-26); REDACTED_ does not.
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    masked = masked.slice(0, s.start) + `[REDACTED_${s.label.toUpperCase()}]` + masked.slice(s.end);
  }
  return masked;
}
