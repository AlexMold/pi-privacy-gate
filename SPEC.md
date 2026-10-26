# pi-privacy — Specification

Privacy gate for Pi: local PII detection, span redaction, file-level withholding, and
local-model analysis (`privacy_analyze`). Cloud models orchestrate; private content never
reaches the cloud provider.

Status: **description, not system** (FPF: the design tree below is a MethodDescription; the
package is Work). Release decision is separate (SYSE.14), taken after M6.

## Claim Register (A.6.B)

Boundary discipline: the gate is a trust boundary. Claims are classified L (law/definition),
A (admissibility predicate), D (deontic duty), E (evidence/effect). Tests MUST reference
these IDs; a test that checks a norm without citing its ID fails the M6 lint.

| ID | Kind | Claim |
|----|------|-------|
| L-1 | L | PII categories are the 9 PII Tracer labels: `private_person`, `private_email`, `private_phone`, `private_address`, `private_url`, `private_date`, `account_number`, `secret`, `other_pii` |
| L-2 | L | Sensitivity units: **span** (token range in one message/tool result), **tool result** (whole output of one tool call), **session** |
| L-3 | L | "Cloud provider" = the provider the selected physical model belongs to, when it is not the configured local provider. "Local model" = the provider/model pair from `privacy-router.json` |
| A-1 | A | Withhold predicate: a tool result is withheld when it contains ≥1 span whose category ∈ `withholdCategories`. Full content goes to the local side-store; context receives a placeholder |
| A-2 | A | Redact predicate: spans whose category ∈ `redactCategories` (and any span in withheld-then-allowed or residual content) are replaced with `[REDACTED_category]` |
| A-3 | A | Allowlist predicate: content referenced by an entry in the allowlist (`/privacy-allow file|session`) bypasses A-1/A-2 |
| D-1 | D | Fail-closed: when the detector or local model is unavailable for a sensitive request, the request MUST NOT be sent to a cloud provider. Retry `retryTimeout` (default 5s), then block with an explanatory error |
| D-2 | D | When `privacy-router.json` has no valid `localModel`, all sensitive requests MUST be blocked with an instructive error |
| D-3 | D | The answer of `privacy_analyze` MUST pass through the detector before entering conversation context (spans redacted per A-2) |
| D-4 | D | Injected sections (system prompt, memory, AGENTS.md, skills) are exempt from the gate. The gate scans user messages and tool results only |
| D-5 | D | Gate mechanisms MUST NOT rely on prompt instructions ("do not send my data") — enforcement is outside the LLM |
| E-1 | E | Canary suite results: 4/4 synthetic files (bank CSV, ISP agreement, medical note, parking ticket) withheld on A-1 categories; benign corpus (4 files) — 0 withholds, 1 false-positive span (2026-10-26) |
| E-2 | E | PII-TRACE (full 500-conversation release, 2653 gold spans): micro exact typed-span F1 72.7% (P 70.8 / R 74.7), untyped F1 80.8%. Per-label: account_number recall 98% (220/224) with 373 FP; secret recall 18.6% (39/210); other_pii recall 1.4% (3/211) |
| E-3 | E | Dogfooding (2026-10-26, 3 scripted sessions with privacy/auto on google/gemini-3.7-flash): run 1 — withhold held, privacy_analyze failed on stale ollama catalog (fixed: refresh fallback); run 2 — found mask self-trigger recursion (fixed: SPEC A-2 format); run 3 — full E2E green, cloud saw only [REDACTED_*]. Journal: bench/dogfood-journal.md |

## Design tree (settled decisions)

| # | Decision | Choice |
|---|----------|--------|
| 1 | MVP scope | Privacy router + redaction (virtual model + hooks), no confirm dialogs |
| 2 | PII engine | PII Tracer GGUF (596M, MIT, 9 categories + sensitivity head) via llama-server |
| 3 | Two-tier mechanism | `privacy_analyze` tool: cloud orchestrates, local model computes on private content; only the (re-scanned) answer enters context |
| 4 | Detector runtime | Self-managed by default: `/privacy-setup` downloads weights + llama-server, supervises the process. External backends via config: `detector.mode = "http"` (any endpoint answering `{text} -> {spans}`) or `"command"` (stdin -> JSON on stdout). Managed reuses M0 artifacts when present (idempotent). Span output is validated at the boundary (bounds clamped, labels checked) |
| 5 | Fail-closed | Retry then block (D-1); invalid local model blocks (D-2) |
| 6 | Local model selection | Config file `privacy-router.json`, no wizard |
| 7 | Withhold trigger | Config `withholdCategories` (A-1); other categories redacted (A-2) |
| 8 | Scan scope | All tool results + every outbound request; injected sections exempt (D-4) |
| 9 | Escape hatch | `/privacy-allow file|session` command (A-3), works in TUI and headless |
| 10 | Distribution | Pi package on npm, name `pi-privacy`, MIT |
| 11 | Verification | Unit tests + canary suite + PII-TRACE subset + dogfooding |
| 12 | Session control | `/privacy on|off|status` — gate active only when the session model is `privacy/auto` |
| 13 | Platforms | macOS + Linux; Windows out of v1 |
| 14 | Non-goals | Injected context protection (D-4, documented); local disk (transcripts on the user's machine are out of scope) |

## Config schema (privacy-router.json)

```json
{
  "detector": { "mode": "managed", "port": 18080 },
  "localModel": { "provider": "ollama", "model": "qwen2.5:3b" },
  "cloudModel": { "provider": "anthropic", "model": "claude-sonnet-4-5" } // fallback only: route follows the session's current model,
  "withholdCategories": ["account_number", "secret", "private_address"],
  "redactCategories": ["private_person", "private_email", "private_phone", "private_url", "private_date", "other_pii"],
  "retryTimeoutSec": 5,
  "spanConfidenceThreshold": 0.5,
  "sensitivityThreshold": 0.5,
  "allowlist": []
}
```

`spanConfidenceThreshold` / `sensitivityThreshold` are calibration points (A.20): defaults
declared, recalibration documented after M6 measurements.

## Assurance (B.3 — filled 2026-10-26)

```text
AssuranceResult:
  targetClaimRef:  "In privacy/auto mode, no PII span of withhold categories from tool
                    results or user messages egresses to the cloud provider"
  assuranceUse:    v1 local release + dogfooding decision
  basisRefs:       E-1 (canary), E-2 (PII-TRACE), E-3 (dogfooding), unit tests (39)
  disposition:     supported-for-use (local v1), with limitations below
  limitationsAndNotCarried:
    - secret recall 18.6% on PII-TRACE synthetic secrets (real API keys detected well in
      spike; synthetic credential formats are missed) — secret is best-effort
    - other_pii recall 1.4% — the detector rarely emits this label
    - account_number: 373 FP on benchmark -> extra withholds (friction, safe direction)
    - injected context (memory/AGENTS.md/skills) is exempt by design (D-4)
    - image content in tool results is not scanned in v1
    - Windows unsupported; detector-down user-message blocking relies on context
      replacement, not provider-level refusal
    - PII-TRACE is a controlled synthetic benchmark, not deployment-level evidence
  reopenCondition:
    - demonstrated egress incident in dogfooding or red-team
    - PII-Tracer weights update, retraction, or license change
    - Pi changes semantics of tool_result / context / virtual-model hooks
    - latency budget exceeded (currently ~0.35ms/token + ~70ms/request, 1024-token windows)
    - threshold recalibration on real deployment data shows material F1 drop
```
