# Detector Spike Report — PII-Tracer-GGUF

Date: 2026-10-26. Machine: Mac (Apple Silicon, Metal), llama-server from Homebrew.

## What was verified

| # | Question | Result |
|---|----------|--------|
| 1 | PII-Tracer-GGUF contents | f16 GGUF backbone (1.2GB) + fp32 heads `heads.safetensors` (156KB) + `pii_head_config.json` (37 BIOES labels, Viterbi biases) + `example_client.py` |
| 2 | Decoding client language | **Python** (torch+safetensors+transformers, heavy). But the decoder is pure math: ~80 lines of Viterbi + two linear heads. Tokenizer: byte-level BPE (GPT2 regex) |
| 3 | TS tokenizer port | **Byte-exact**: our encode() produces identical token ids to llama-server `/tokenize` on ASCII, Cyrillic, and a 12K-char text (36/36, 1029/1029 tokens) |
| 4 | Canonical example | Matches the HF README: person/email/phone, scores 0.999-1.000, correct masking |
| 5 | Categories | 8 of 9 verified: account_number, private_address, private_date, private_email, private_person, private_phone, private_url, secret — all detected (0.999-1.000). other_pii not tested separately |
| 6 | Cyrillic | Works: "Александр Грибков" → private_person 1.000; multi-byte offsets correct |
| 7 | Latency | Small text: **~80ms**. 2600 tokens (12K chars): **~900ms** (embed) + 73ms (heads+Viterbi). Full 4096-token chunk ≈ **1.4s**. Tokenization: 0.6-4.8ms |
| 8 | Self-managed path | llama.cpp releases carry per-platform binaries: macos-arm64 **16.3MB**, macos-x64 12MB, ubuntu-x64 22.5MB, ubuntu-arm64 18.2MB. Versioned by build tag (b11899) |

## Observations and risks

- **Window size is critical (found in M1):** the model misses PII near the tail of long
  windows. Repetitive filler: reliable at ≤~1400 tokens before the span, misses at ~1600+;
  varied text degrades later. Decision: **1024-token windows, no overlap** — any span is at
  most 1023 tokens from a window start. Cost: more requests (~0.35ms/token + ~70ms/request).
- **private_date boundary artifact:** "1992-03-14" detects as "992-03-14" (first digit
  lost) at score 1.000 — a model artifact, not a port bug. Mitigated by threshold
  calibration, not code.
- **Sensitivity head reads ~0.03 on short texts** — conversation-level sensitivity is
  useless for tool results. v1 predicates rely on span detection only; sensitivity stays
  raw in the API.

## SYSE.24:4.3 — arrangement comparison

| Question | A: TS port + llama-server | B: Python sidecar (numpy+tokenizers) |
|----------|---------------------------|--------------------------------------|
| Result | Detector entirely inside the npm package; the only external process is llama-server | Plus a Python process and venv |
| Who does what | Extension spawns llama-server; TS: tokenizer, heads, Viterbi | A Python service does everything except llama-server |
| Production/access | `npm install` — that's all | npm + python3 + pip venv (not guaranteed on user machines) |
| Integration | One supervised process | Two processes, IPC, version drift |
| Reliance basis | Byte-exact tokenizer verification (this spike) + canonical example | Same correctness; numpy is reliable |
| After first use | Updates = npm + weights | Plus venv/python drift |
| Capability change | TS BPE reusable; no new machine requirements | Requires a Python environment |
| Resources | 1.2GB weights + 16MB binary + ~1.4s/chunk | Same + ~50MB Python deps |

## Decision

**GO on arrangement A: full TS port, no sidecar.** Basis: byte-exact tokenization proven
against a live server, canonical example reproduced, no Python dependency for users —
decisive for community distribution across different local setups.

Residual conditions: (1) span-confidence threshold calibration in M1 with defaults;
(2) the sensitivity head participates in no v1 predicate; (3) latency budget documented
honestly in the README; (4) scan window is 1024 tokens (see Observations).
