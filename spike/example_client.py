#!/usr/bin/env python3
"""Mask PII in text via llama-server + the pplx-pii-masking heads.

Self-contained: the constrained BIOES Viterbi decoder is inlined below and
reads the label list + biases from pii_head_config.json.

Prereqs:
  llama-server -m pplx-pii-masking-backbone-f16.gguf --embeddings --pooling none \
      -c 4096 -b 4096 -ub 4096
  pip install torch safetensors transformers

Usage: example_client.py "some text with daniels@meridiancap.com in it"
"""
from __future__ import annotations

import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import torch
from safetensors.torch import load_file
from transformers import PreTrainedTokenizerFast

SERVER = "http://127.0.0.1:8080"
HERE = Path(__file__).parent


# ---------------------------------------------------------------------------
# Constrained BIOES Viterbi decoder
# ---------------------------------------------------------------------------

@dataclass
class PredictedSpan:
    start: int   # character offset in document text
    end: int
    label: str   # e.g. "private_person"
    score: float


def strip_span_whitespace(text: str, spans: list[PredictedSpan]) -> list[PredictedSpan]:
    """Trim leading/trailing whitespace from predicted character spans.

    Tokenizers fuse the space before a word into the token (e.g. '_john'),
    so the B-token's char_start is one position before the actual PII value.
    """
    out: list[PredictedSpan] = []
    for s in spans:
        new_start, new_end = s.start, s.end
        while new_start < new_end and text[new_start] in (" ", "\t", "\n"):
            new_start += 1
        while new_end > new_start and text[new_end - 1] in (" ", "\t", "\n"):
            new_end -= 1
        if new_start < new_end:
            out.append(PredictedSpan(new_start, new_end, s.label, s.score))
    return out


class ViterbiDecoder:
    """Constrained BIOES Viterbi decoder with transition bias scalars.

    The bias scalars are added to all ->B and E-> transitions, allowing
    precision/recall trade-offs without retraining.
    """

    def __init__(self, labels: list[str], b_bias: float = 0.0, e_bias: float = 0.0):
        self.labels = labels
        self.num_labels = len(labels)
        self.label2id = {label: idx for idx, label in enumerate(labels)}
        self.id2label = {idx: label for idx, label in enumerate(labels)}
        self.pii_types = [label[2:] for label in labels if label.startswith("S-")]
        self.b_bias = b_bias
        self.e_bias = e_bias

    def _build_transition_scores(self) -> torch.Tensor:
        """[num_labels, num_labels] float transition score matrix."""
        n, l2i = self.num_labels, self.label2id
        mask = torch.zeros(n, n, dtype=torch.bool)
        end_states = {l2i["O"]}    # states a span can end on (O, E-*, S-*)
        begin_states = {l2i["O"]}  # states valid after a boundary (O, B-*, S-*)
        for pii_type in self.pii_types:
            b, i = l2i[f"B-{pii_type}"], l2i[f"I-{pii_type}"]
            e, s = l2i[f"E-{pii_type}"], l2i[f"S-{pii_type}"]
            end_states |= {e, s}
            begin_states |= {b, s}
            mask[b, i] = mask[b, e] = True   # B -> I/E of same type
            mask[i, i] = mask[i, e] = True   # I -> I/E of same type
        for from_state in end_states:
            for to_state in begin_states:
                mask[from_state, to_state] = True

        scores = torch.full((n, n), float("-inf"))
        scores[mask] = 0.0
        for pii_type in self.pii_types:
            b, e = l2i[f"B-{pii_type}"], l2i[f"E-{pii_type}"]
            for from_s in range(n):
                if scores[from_s, b] > float("-inf"):
                    scores[from_s, b] += self.b_bias   # entering B states
            for to_s in range(n):
                if scores[e, to_s] > float("-inf"):
                    scores[e, to_s] += self.e_bias     # leaving E states
        return scores

    @torch.no_grad()
    def decode(
        self,
        logits: torch.Tensor,
        offset_mapping: list[tuple[int, int]],
        text: str | None = None,
    ) -> list[PredictedSpan]:
        """Decode a single sequence.

        Args:
            logits: [T, num_labels] float tensor
            offset_mapping: list of (char_start, char_end) per token
            text: source text; when provided, leading/trailing whitespace is
                stripped from predicted span boundaries.
        """
        T, C = logits.shape
        assert C == self.num_labels

        trans = self._build_transition_scores()  # [C, C]

        viterbi_scores = torch.full((T, C), float("-inf"))
        backpointers = torch.zeros((T, C), dtype=torch.long)

        # t=0: only O / B-* / S-* are valid start states
        start_mask = torch.full((C,), float("-inf"))
        for label, idx in self.label2id.items():
            if label == "O" or label.startswith("B-") or label.startswith("S-"):
                start_mask[idx] = 0.0
        viterbi_scores[0] = logits[0] + start_mask

        for t in range(1, T):
            # [C, 1] + [C, C] -> [C, C]; dim-0 = prev, dim-1 = next
            scores_t = viterbi_scores[t - 1].unsqueeze(1) + trans
            best_prev, best_idx = scores_t.max(dim=0)
            viterbi_scores[t] = logits[t] + best_prev
            backpointers[t] = best_idx

        # End constraint: only O / E-* / S-* valid at end
        end_mask = torch.full((C,), float("-inf"))
        for label, idx in self.label2id.items():
            if label == "O" or label.startswith("E-") or label.startswith("S-"):
                end_mask[idx] = 0.0
        best_last = int((viterbi_scores[T - 1] + end_mask).argmax().item())

        path = [best_last]
        for t in range(T - 1, 0, -1):
            path.append(int(backpointers[t, path[-1]].item()))
        path.reverse()

        spans = self._path_to_spans(path, logits, offset_mapping)
        if text is not None:
            spans = strip_span_whitespace(text, spans)
        return spans

    def _path_to_spans(
        self,
        path: list[int],
        logits: torch.Tensor,
        offset_mapping: list[tuple[int, int]],
    ) -> list[PredictedSpan]:
        spans: list[PredictedSpan] = []
        T = len(path)
        t = 0
        while t < T:
            label = self.id2label[path[t]]
            char_start, char_end = offset_mapping[t]

            if label.startswith("S-"):
                pii_type = label[2:]
                score = float(logits[t, path[t]].sigmoid().item())
                if char_start < char_end:
                    spans.append(PredictedSpan(char_start, char_end, pii_type, score))
                t += 1

            elif label.startswith("B-"):
                pii_type = label[2:]
                span_start, span_end = char_start, char_end
                tok_scores = [float(logits[t, path[t]].item())]
                t += 1
                while t < T:
                    inner = self.id2label[path[t]]
                    if inner == f"I-{pii_type}":
                        _, span_end = offset_mapping[t]
                        tok_scores.append(float(logits[t, path[t]].item()))
                        t += 1
                    elif inner == f"E-{pii_type}":
                        _, span_end = offset_mapping[t]
                        tok_scores.append(float(logits[t, path[t]].item()))
                        t += 1
                        break
                    else:
                        break
                if span_start < span_end:
                    score = float(torch.tensor(tok_scores).mean().sigmoid().item())
                    spans.append(PredictedSpan(span_start, span_end, pii_type, score))

            else:
                t += 1

        return spans


# ---------------------------------------------------------------------------
# Client: llama-server embeddings -> heads -> Viterbi -> masked text
# ---------------------------------------------------------------------------

text = sys.argv[1]

heads = load_file(str(HERE / "heads.safetensors"))
cfg = json.loads((HERE / "pii_head_config.json").read_text())

# tokenizer only needed for offsets; ids must match the server's tokenization
tok = PreTrainedTokenizerFast(tokenizer_file=str(HERE / "tokenizer.json"))
enc = tok(text, return_offsets_mapping=True, truncation=True, max_length=4096)

req = urllib.request.Request(f"{SERVER}/embeddings",
                             data=json.dumps({"content": text}).encode(),
                             headers={"Content-Type": "application/json"})
emb = torch.tensor(json.loads(urllib.request.urlopen(req).read())[0]["embedding"])
assert emb.shape[0] == len(enc["input_ids"]), "tokenization mismatch vs server"

logits = emb @ heads["token_cls_head.weight"].T + heads["token_cls_head.bias"]
sens = torch.sigmoid(emb.mean(0) @ heads["sensitivity_head.weight"].T
                     + heads["sensitivity_head.bias"]).item()

viterbi = ViterbiDecoder(cfg["labels"], cfg["viterbi_b_bias"], cfg["viterbi_e_bias"])
spans = viterbi.decode(logits, enc["offset_mapping"], text=text)

masked = text
for s in sorted(spans, key=lambda s: -s.start):
    masked = masked[:s.start] + f"[{s.label.upper()}]" + masked[s.end:]

print(f"sensitivity: {sens:.3f}")
for s in spans:
    print(f"  {s.label:18s} [{s.start}:{s.end}] {text[s.start:s.end]!r}")
print(masked)
