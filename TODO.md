# TODO

## Goal
v0.3 of **pi-privacy-gate**: a deterministic secret-rules layer (vendored gitleaks patterns,
curated default subset) merged into the scan pipeline, adding coverage for real-format
provider keys where the ML detector misses (E-2: secret recall 18.6%). Rule hits are
spans labeled `secret` and feed the existing A-1/A-2 machinery unchanged. Evidence for
rules lands as a separate claim (E-5); E-2 stays untouched (no recall numbers are merged
across corpora — C.16 scope boundary).

## Tasks

### 8. M7 — Secret rules layer (v0.3, this plan)
- [x] Vendor gitleaks rules as `vendor/gitleaks.yaml` (converted from the pinned gitleaks
      TOML release, source version + commit + MIT attribution recorded in
      `vendor/README.md`); `js-yaml` + `smol-toml` added as devDependencies, build-time only
- [x] `scripts/compile-gitleaks.ts`: YAML → TS rules file `src/rules/gitleaks.ts`
      (id, description, pattern, default flag); attempts JS RegExp compilation for every
      rule, skips and reports incompatible ones; target: ≥150 rules compile of ~180;
      fails loudly if any curated default rule ID is missing from the vendored YAML
      (build-step constraint validity, A.20)
- [x] Curated default subset: explicit rule-ID list in the compile script (cloud keys:
      AWS/GCP/Azure, VCS: GitHub/GitLab, AI providers: OpenAI/Anthropic, private keys,
      JWTs, DB/URL connection strings, generic-api-key) marked `default: true`; the rest
      available via config
- [x] Rule engine `src/secretRules.ts`: rules → `PredictedSpan[]` with label `secret`
      (the 9-label set of L-1 is not extended — A.6.B atomic claims, A.11 parsimony),
      score 1.0 (exact pattern match; participates in spanConfidenceThreshold gating —
      documented), char offsets; overlap dedupe (one span per maximal match); bounded work
      (no catastrophic backtracking — each rule compiled once, tested against 10KB input)
- [x] Config: `secretRules: "off" | "loyal" | "default" | "all"` in privacy-router.json
      (default `"default"`), parsed and validated in `src/config.ts`. Loyal = rule-detected
      secrets are redacted in place (A-2) instead of withholding the whole tool result
      (A-1); predicates unchanged, mode changes only which predicate applies
- [x] Wire composite scan fn in `extensions/index.ts` `initGate()`: ML spans + rule spans
      merged (dedupe overlapping spans, rule span wins), feeding `PrivacyGate.decide`
      unchanged; with `"off"` the pipeline is byte-identical to v0.2.1 on the existing
      test suite (regression witness, A.20)
- [x] Unit tests (`test/secretRules.test.ts` + gate integration): canonical secrets
      (AWS key, GitHub PAT, OpenAI sk- key, PEM private key, JWT, postgres://user:pass URL)
      → withhold with `secret` category on default; loyal → redact in place, no withhold;
      all → full pack; off → no rule spans; tests cite Claim Register IDs
      (passes `npm run lint:claims`)
- [x] Evidence: secrets canary corpus (planted real-format test keys) → new E-5 entry in
      SPEC.md as its own claim (rule-layer corpus only; never merged with E-2 numbers);
      update assurance card: limitations now name both layers, reopen condition added for
      "gitleaks upstream ruleset update (vendored pin — refresh is a decision)";
      update README (config key incl. loyal mode, rule coverage, "secret is best-effort"
      wording)
- [x] Version bump 0.2.1 → 0.3.0 in package.json

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
- **FPF review of this plan (2026-11-06), findings applied:**
  - A.6.B / A.11: `loyal` mode must not create a 10th PII label — rules emit `secret`,
    mode changes only which predicate (A-1 vs A-2) applies. A new label = L-1 amendment
    with its own decision.
  - A.20: rule span score is a declared constant (1.0), not measured confidence; it must
    stay above any user-set `spanConfidenceThreshold` or the layer silently no-ops —
    test covers this.
  - A.10 / C.16: E-2 (ML, PII-TRACE) and E-5 (rules, real-format key corpus) stay separate
    claims on separate corpora; no combined "recall" number may be published.
  - A.20 on the build step: compile script fails loudly when a curated rule ID is missing
    from the vendored YAML (IDs drift between gitleaks releases).
  - G.11/currentness: vendored pin creates an update obligation — reopen condition added
    to the assurance card.
- **M7 scope exclusions (v0.3):** no custom user regex rules (separate gap), no
  tool-call argument scanning (separate gap, blind spot #7), no entropy-only detectors
  (gitleaks entropy rules skipped — regex rules only in v0.3), no interactive
  allow/redact prompts (design-tree decision #1 stays).
- **Licensing:** gitleaks is MIT; vendored YAML keeps the license header, source pin and
  conversion note in vendor/README.md. Runtime stays dependency-free; js-yaml is
  build/dev-time only.
- **FP posture:** curated default (not full pack) because account_number already yields
  373 benchmark FP — a loud secret pack would add withhold friction to every session.
  `loyal` mode is the low-friction option: detection stays on, whole-file withhold
  switches to in-place redaction (weaker than withhold — the rest of the file stays
  visible; that is the explicit trade-off of the mode).
- **What M7 does NOT change:** claim IDs A-1/A-2/D-1/D-5 machinery untouched; rule hits
  are just spans labeled `secret`, which is already in DEFAULT_WITHHOLD_CATEGORIES.
  PII-TRACE secret recall (synthetic, E-2) stays as-is — rules evidence lands in E-5
  on real-format provider keys instead.
- **Implementation note (discovered during execution, same intent as the plan):**
  "feeding PrivacyGate.decide unchanged" was not fully possible — loyal mode needs the
  gate to distinguish rule-origin spans from ML spans (same label `secret`). Landed as
  an optional `origin?: "rule"` field on PredictedSpan + `redactOnlyLabels` gate option;
  predicates themselves unchanged. Also `secrets-canary.test.ts` added beyond the plan
  text (plan said "canary corpus"; it needed a test to run it).
- **npm publish stays out of scope** (waiting for explicit go, as before).
- **Platforms:** macOS + Linux download paths; Windows out of v1.
- **Design-tree decisions:** two-tier via privacy_analyze; PII Tracer GGUF; self-managed
  /privacy-setup with pluggable http/command detector backends; fail-closed retry→block;
  config file, no wizard; withhold by config categories; scan all tool results;
  /privacy-allow as the escape hatch; verification = canary + PII-TRACE + dogfooding + unit.
- **FPF discipline:** the design tree is a description, not the system; M0 go ≠ release
  (the release decision is separate, SYSE.14).
