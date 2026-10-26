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
| E-1 | E | Canary suite results: planted PII of all 9 categories withheld/redacted; FP-rate on benign corpus measured (filled in M6) |
| E-2 | E | PII-TRACE subset F1 for the detector (filled in M6) |
| E-3 | E | Dogfooding observations: provider logs inspected for egress on real sessions (filled in M6) |

## Design tree (settled decisions)

| # | Decision | Choice |
|---|----------|--------|
| 1 | MVP scope | Privacy router + redaction (virtual model + hooks), no confirm dialogs |
| 2 | PII engine | PII Tracer GGUF (596M, MIT, 9 categories + sensitivity head) via llama-server |
| 3 | Two-tier mechanism | `privacy_analyze` tool: cloud orchestrates, local model computes on private content; only the (re-scanned) answer enters context |
| 4 | Detector runtime | Self-managed: `/privacy-setup` downloads weights + llama-server binary, supervises process. Reuses M0 artifacts when present (idempotent) |
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
  "localModel": { "provider": "ollama", "model": "qwen2.5:3b" },
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

## Assurance (B.3 — to be completed in M6)

- **Target claim:** in `privacy/auto` mode, no span of withhold categories from tool results
  or user messages egresses to the cloud provider.
- **Use:** v1 release decision.
- **Disposition / limitations / reopen conditions:** filled in M6 (minimum reopen conditions:
  demonstrated egress; PII Tracer update or retraction; Pi hook semantics change; latency
  budget exceeded).
