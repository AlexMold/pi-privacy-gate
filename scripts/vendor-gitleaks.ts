/**
 * Vendor gitleaks rules → vendor/gitleaks.yaml (one-time conversion, M7 / TODO 8.1).
 *
 * Usage: node scripts/vendor-gitleaks.ts --toml <gitleaks.toml> --version 8.30.1 --commit <sha>
 * Source: https://github.com/gitleaks/gitleaks (MIT), config/gitleaks.toml at the pinned tag.
 *
 * Carried per rule: id, description, regex, keywords (OR prefilter).
 * Carried per rule when present: match-target allowlist regexes + stopwords.
 * Skipped (documented in vendor/README.md): global [allowlist], path rules, allowlist
 * blocks with `paths` or regexTarget="line", entropy fields (out of scope for v0.3).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { dump } from "js-yaml";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
}

const tomlPath = arg("toml");
const version = arg("version");
const commit = arg("commit");

const doc = parse(readFileSync(tomlPath, "utf8")) as {
  rules?: Array<Record<string, unknown>>;
};

const skipped: string[] = [];
const rules = [];
for (const r of doc.rules ?? []) {
  const id = r.id as string | undefined;
  const regex = r.regex as string | undefined;
  if (!id || typeof regex !== "string") {
    skipped.push(id ?? "(no id)");
    continue;
  }
  const rule: Record<string, unknown> = {
    id,
    description: r.description ?? "",
    regex,
  };
  if (Array.isArray(r.keywords)) rule.keywords = r.keywords;
  const outAllowlists = [];
  for (const al of (r.allowlists as Array<Record<string, unknown>>) ?? []) {
    // port only match-target allowlists: no paths, no regexTarget="line"
    if (al.paths !== undefined) continue;
    if (al.regexTarget === "line") continue;
    const block: Record<string, unknown> = {};
    if (Array.isArray(al.regexes)) block.regexes = al.regexes.filter((x) => typeof x === "string");
    if (Array.isArray(al.stopwords)) block.stopwords = al.stopwords.filter((x) => typeof x === "string");
    if (Object.keys(block).length > 0) outAllowlists.push(block);
  }
  if (outAllowlists.length > 0) rule.matchAllowlists = outAllowlists;
  rules.push(rule);
}

const header = [
  `# Vendored from gitleaks v${version} (MIT), config/gitleaks.toml at commit ${commit}`,
  `# https://github.com/gitleaks/gitleaks — converted from TOML by scripts/vendor-gitleaks.ts`,
  `# Do not edit by hand: re-run the vendor script to refresh the pin (refresh is a decision, see TODO.md Notes).`,
  `# Not carried: global [allowlist] (path-based), rules without regex, allowlist blocks with`,
  `# paths or regexTarget="line", entropy fields. Skipped rules: ${skipped.join(", ") || "none"}`,
  "",
];

const out = {
  source: `gitleaks v${version}`,
  commit,
  license: "MIT",
  rules,
};

writeFileSync("vendor/gitleaks.yaml", header.join("\n") + dump(out, { lineWidth: -1 }));
console.log(`vendor/gitleaks.yaml written: ${rules.length} rules, skipped: ${skipped.length} (${skipped.join(", ")})`);
