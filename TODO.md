# TODO

## Goal
A locally working v1 of **pi-privacy-gate**: a PII gate for Pi (PII Tracer GGUF detector
via llama-server, tool-result withhold/redact, `privacy_analyze` on the local model,
fail-closed), verified by a canary suite, the PII-TRACE benchmark, and dogfooding.

## Tasks

### 0. Repo & skeleton
- [x] `git init`, `.gitignore` (node_modules, model weights, artifacts)
- [x] SPEC.md: Claim Register per A.6.B — gate norm IDs (L-1 PII categories, A-1 withhold
      predicate, A-3 allowlist predicate, D-1 fail-closed, D-2 block without a valid local
      model) + settled design-tree decisions
- [x] package.json: name `pi-privacy-gate`, license MIT, peerDependencies on Pi host
      packages, `pi` manifest (extensions)

### 1. M0 — Detector spike (SYSE.24 bounded probe, go/no-go before M1)
- [x] Download perplexity-ai/PII-Tracer-GGUF (~1.2GB), inspect contents: f16 backbone, fp32 heads, decoding client
- [x] Determine the decoding client's language and self-containment → TS Viterbi port vs micro-sidecar (in the spike report)
- [x] Start llama-server with the model, run the HF README canonical example, verify spans (private_person/email/phone)
- [x] Measure latency on a Mac for large chunks
- [x] Verify the self-managed path: llama-server binary download (macOS + Linux), spawn, health-check
- [x] Spike report: GGUF+llama-server vs Python-sidecar across the 8 SYSE.24:4.3 questions + go/no-go. M1 only starts after go

### 2. M1 — Detector service
- [x] `/privacy-setup` command: reuse weights and llama-server from M0 when already present; idempotent; health-check; persist state
- [x] llama-server supervisor: start on session_start, stop on session_shutdown
- [x] Scan API in TS: text → spans (9 categories) + sensitivity score, token-window chunking, Viterbi decoder (per the M0 decision: full TS port)
- [x] Unit tests on canonical examples (email, phone, account_number, private_person)

### 3. M2 — Gate mechanics
- [x] `tool_result` hook: scan all tool results; withhold-category spans (A-1) → content to side-store, placeholder to context; other spans → `[REDACTED_category]`
- [x] Provider-agnostic outbound redaction via the `context` hook; injected sections (system/memory/skills) exempt (D-4)
- [x] Notifications via ui.notify (TUI/RPC-safe, no dialogs)
- [x] Unit tests: withhold, redact, placeholder, injected-context exemption

### 4. M3 — privacy_analyze
- [x] `privacy_analyze(question, fileRef)` tool: side-store lookup, local model from config (via ctx.modelRegistry), answer returned
- [x] Tool answer passes through the detector before entering context (D-3)
- [x] Unit tests: canonical sensitive file, answer redaction

### 5. M4 — Fail-closed, config, allowlist
- [x] privacy-router.json: localModel, cloudModel, withhold/redactCategories, retryTimeout, calibration thresholds, allowlist, detector backend
- [x] Fail-closed (D-1, D-2): retry N sec → block with error; invalid localModel → all sensitive requests blocked with an instructive error
- [x] `/privacy-allow file|session` → allowlist (works in TUI and headless)
- [x] Unit tests: retry-then-block, invalid config, allowlist bypass

### 6. M5 — Virtual model and packaging
- [x] `registerVirtualModel` `privacy/auto`: gate active only there; routes to the session's current model (cloudModel is a fresh-session fallback)
- [x] `/privacy on|off|status`: session-scoped gate toggle + state
- [x] Package build (pi manifest, peerDependencies), local load verified via `pi -e ./`
- [x] README (EN): install, /privacy-setup, config, limitations — injected context exempt, egress protection only, not local disk

### 7. M6 — Verification and dogfooding
- [x] Canary suite: synthetic files with planted PII + benign corpus for FP-rate
- [x] PII-TRACE full release: detector F1 measured, thresholds recorded
- [x] Dogfooding: privacy/auto on real sessions, egress checked, findings journal
- [x] B.3 assurance card in SPEC.md: target claim, use, disposition, limitations, reopen conditions
- [x] Claim lint: every gate test cites a Claim Register ID

## Post-v1 (publish track)
- [x] Rename to `pi-privacy-gate` (npm `pi-privacy` taken by privateer-agent)
- [x] files whitelist, LICENSE (personal MIT), repository metadata
- [x] English-only repo content (TODO, docs)
- [x] Egress-proof: payload-level capture test (E-4)
- [x] ADR-0001 package name
- [ ] `npm publish` + push (waiting for explicit go)

## Notes
- **Platforms:** macOS + Linux download paths; Windows out of v1.
- **Design-tree decisions:** two-tier via privacy_analyze; PII Tracer GGUF; self-managed
  /privacy-setup with pluggable http/command detector backends; fail-closed retry→block;
  config file, no wizard; withhold by config categories; scan all tool results;
  /privacy-allow as the escape hatch; verification = canary + PII-TRACE + dogfooding + unit.
- **FPF discipline:** the design tree is a description, not the system; M0 go ≠ release
  (the release decision is separate, SYSE.14).
