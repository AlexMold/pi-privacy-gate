# ADR-0001: Package name is `pi-privacy-gate`

Date: 2026-10-27
Status: Accepted

## Context

The project started as `pi-privacy` (working name, directory `pi-privacy-router`). When
preparing the npm publication we found the name **taken**: [`pi-privacy`][1] by
privateer-agent (Patrick/zahnno) — "Privacy posture + TEE attestation for Pi providers …
on-device PII detection", actively developed (0.14.1 at check time). Overlapping domain,
same Pi ecosystem.

## Decision

Publish as **`pi-privacy-gate`** on npm, repository `AlexMold/pi-privacy-gate` on GitHub.

## Alternatives considered

- `pi-privacy-router` (free) — rejected: "router" no longer describes the behavior (the
  virtual model continues on the user's current model; it gates, it does not reroute),
  and it stays phonetically close to the competitor.
- `@alexmold/pi-privacy` (free) — rejected: scoped names are harder to find in the Pi
  package gallery and read as personal forks rather than ecosystem tools.
- Renaming to something unrelated — rejected: discoverability for "privacy" + "Pi" is the
  whole point; the suffix `-gate` says precisely what the package is.

## Consequences

- The install command is `pi install npm:pi-privacy-gate` everywhere (README, SPEC, docs).
- The on-disk data directory stays `~/.pi-privacy` (changing it would break existing
  installs; it is an internal detail, relocatable via `PI_PRIVACY_DIR`).
- The `pi-privacy:` message prefix inside the extension stays as the product brand.

[1]: https://www.npmjs.com/package/pi-privacy
