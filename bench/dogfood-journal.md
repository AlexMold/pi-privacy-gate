# Dogfooding journal (E-3)

Scripted sessions: `pi -e ./ --print --model pi-privacy/auto`, cloud
google/gemini-3.7-flash, local ollama. Target file:
`bench/canary/bank_statement.csv` (planted account_number, private_email).

## Run 1 (2026-10-26)

- **Gate held:** read withheld, categories detected (account_number, private_email),
  side-store key `a215d986bb158ec0`, cloud got placeholder only.
- **Bug:** privacy_analyze failed. Root cause: stale local-model config
  (`ollama/gemma4:31b` existed in pi's catalog but not in Ollama — models.json drift).
- **Finding:** the cloud agent edited `extensions/index.ts` during the run, replacing
  `completeSimple` with `streamSimple(...).result()` — valid API, kept after review.
- **Fix:** config → `ollama/qwen3.6:35b-a3b-q4_K_M` (real Ollama model); refresh
  fallback added to the tool's model lookup.

## Run 2 (2026-10-26)

- **Full pipeline worked:** read withheld → privacy_analyze answered locally → answer
  masked → but then **recursive withhold**: the mask `[ACCOUNT_NUMBER]` itself was
  detected by PII-Tracer as `account_number` (score 0.726 ≥ 0.5), so the tool_result
  hook re-withheld the already-masked answer.
- **Finding:** mask format diverged from SPEC A-2. The claim register says
  `[REDACTED_category]`; the code used `[CATEGORY]` (ported from the Python client).
  On `[REDACTED_account_number]` the detector returns 0 spans.
- **Fix:** maskText → SPEC A-2 format. Defense-in-depth kept: the answer is still
  re-scanned by the tool_result hook; it just no longer self-triggers.

## Run 3 (2026-10-26)

- **Full E2E green:** withhold → privacy_analyze (qwen3.6:35b) → masked answer
  `[REDACTED_ACCOUNT_NUMBER]` / `[REDACTED_PRIVATE_EMAIL]` entered context, no
  recursion. The cloud model's final reply contained no raw PII.
- Egress check: transcript shows only redacted forms post-context-hook; the cloud
  model itself stated raw PII "cannot be exposed".

## Notes

- Verification method: transcripts of scripted print-mode sessions (post-hook
  messages are what the provider received). Provider HTTP payloads are not logged
  by Pi by default — a red-team trace would need a payload-level hook
  (`before_provider_request` capture) in a future hardening pass.
- The autonomous file edit in run 1 is expected agent behavior; repo state after
  dogfooding was reviewed (see git history).
