/**
 * Secrets canary (SPEC E-5): synthetic file layouts with planted real-format provider
 * keys must be flagged by the deterministic rules layer in default mode; benign fixtures
 * with upstream doc-example values must produce zero spans. Deterministic, no
 * llama-server. Key values are runtime-assembled (test/secretFixtures.ts) — no
 * key-shaped literals in the repository.
 * Claims: A-1 (spans feed withholdCategories via `secret`), E-5.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretRuleScanner } from "../src/secretRules.ts";
import { FIXTURES } from "./secretFixtures.ts";

const scanner = createSecretRuleScanner("default")!;
const { awsAccessKey, awsDocExample, githubPat, openaiKey, slackBot, dbUrl, jwt, pemBlock } = FIXTURES;

/** the E-5 corpus: same file layouts as the original bench/secrets-canary run */
const planted: Array<[string, string]> = [
  ["prod.env", [
    "# deployment env for staging deploy",
    `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
    `AWS_SECRET_ACCESS_KEY=${"mVx9QzLr7Tk2WpBn8Hc4JsYd6Gf1NsEu0Aa5Cd"}`,
    `GITHUB_TOKEN=${githubPat}`,
    `OPENAI_API_KEY=${openaiKey}`,
    `SLACK_BOT_TOKEN=${slackBot}`,
    "",
  ].join("\n")],
  ["deploy-config.yaml", [
    "deploy:",
    "  registry:",
    "    url: registry.internal",
    '    password: "Tq7Wn2Vb5cX8zR4mK9jH3fL6dS1aP0gU"',
    "  notify:",
    `    webhook: https://hooks.slack.com/services/T00000000/B00000000/${"X".repeat(26)}`,
    "",
  ].join("\n")],
  ["db.ini", [
    "[primary]",
    `dsn = ${dbUrl}`,
    "",
  ].join("\n")],
  ["api-notes.md", [
    "# Integration notes (internal)",
    "",
    "Test the webhook with:",
    `curl -H "Authorization: Bearer ${jwt}" https://api.internal/v2/hook`,
    "",
  ].join("\n")],
  ["legacy-key.pem.txt", [
    "Rotated-out legacy key, keep for 30 days for rollback:",
    "",
    pemBlock,
    "",
  ].join("\n")],
];

const benign: Array<[string, string]> = [
  ["fixtures.md", [
    "# Docs fixtures — known examples that detectors MUST NOT flag",
    "",
    `AWS docs example key: ${awsDocExample}`,
    "Sample config: password = examplevalue1234",
    "Contact: no-reply@example.com",
    "Placeholder token: YOUR_API_KEY_HERE",
    "",
  ].join("\n")],
];

for (const [name, text] of planted) {
  test(`secrets canary ${name}: planted key flagged by the default rules pack (E-5, A-1)`, () => {
    const spans = scanner.scan(text);
    assert.ok(
      spans.some((s) => s.label === "secret" && s.origin === "rule"),
      `expected >=1 rule secret span; got ${JSON.stringify(spans)}`,
    );
  });
}

for (const [name, text] of benign) {
  test(`secrets canary benign/${name}: upstream examples suppressed, zero spans (E-5)`, () => {
    assert.deepEqual(scanner.scan(text), [], "benign fixture must not flag");
  });
}
