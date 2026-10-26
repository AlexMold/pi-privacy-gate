# PII-TRACE benchmark — 2026-10-26

Detector: PII-Tracer-GGUF f16, window 1024 tokens, spanConfidenceThreshold 0.5.
Conversations: 500. Gold spans: 2653. Whitespace-trimmed gold spans: 0.

## Micro, exact typed-span (turn, source, start, end, label)

| Metric | Value |
|--------|-------|
| Precision | 70.8% |
| Recall | 74.7% |
| F1 | 72.7% |
| F1 untyped (exact bounds) | 80.8% |

## Per label (typed, micro)

| Label | TP | FP | FN |
|-------|----|----|----|
| private_person | 677 | 89 | 71 |
| private_email | 368 | 41 | 24 |
| account_number | 220 | 373 | 4 |
| private_date | 189 | 10 | 32 |
| private_phone | 185 | 93 | 33 |
| private_address | 167 | 90 | 55 |
| private_url | 133 | 79 | 74 |
| secret | 39 | 17 | 171 |
| other_pii | 3 | 25 | 208 |