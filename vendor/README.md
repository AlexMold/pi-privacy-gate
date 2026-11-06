# vendor/gitleaks.yaml

Deterministic secret-detection rules for pi-privacy-gate (M7), converted from the
gitleaks default config.

- **Source:** https://github.com/gitleaks/gitleaks — `config/gitleaks.toml`
- **Version:** v8.30.1, commit `83d9cd684c87d95d656c1458ef04895a7f1cbd8e`
- **License:** MIT (gitleaks). This file carries the upstream license; gitleaks itself
  is not distributed here, only the converted rule data.

## Conversion

Done by `scripts/vendor-gitleaks.ts` (TOML → YAML, one-time, reproducible):

```bash
node scripts/vendor-gitleaks.ts --toml <gitleaks.toml> --version <tag> --commit <sha>
```

The YAML is the pinned input for `scripts/compile-gitleaks.ts`, which generates
`src/rules/gitleaks.ts` (the runtime artifact). Edit nothing by hand: to refresh the
pin, re-run the vendor script with a new version/commit — that is a decision (TODO.md
Notes, currentness obligation), not an automatic update.

## What is carried per rule

| Field | Use |
| --- | --- |
| `id`, `description` | identity, audit |
| `regex` | the pattern (Go RE2 source; compiled to JS RegExp by the compile step) |
| `keywords` | OR prefilter: the engine checks a rule only when one keyword appears in the text (case-insensitive) |
| `matchAllowlists[]` | match-target suppression `regexes` and `stopwords` (applied to the captured secret), ported so rules like `generic-api-key` stay usable |

## What is NOT carried (documented limits, v0.3)

- Global `[allowlist]` path patterns — the gate scans text, not file trees.
- Rules without a `regex` (skipped: `pkcs12-file` — path-only rule).
- Allowlist blocks with `paths` or `regexTarget: "line"` — file-path and line-level
  suppression do not exist in the gate; those findings may surface as extra matches.
- `entropy` fields — entropy scoring is out of scope for v0.3 (TODO.md Notes).
