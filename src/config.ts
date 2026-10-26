/**
 * privacy-router.json — user configuration (SPEC design tree #6, #7).
 * Lives in DATA_DIR (~/.pi-privacy). Missing file -> defaults.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_WITHHOLD_CATEGORIES, DEFAULT_REDACT_CATEGORIES } from "./gate.ts";

/** resolved lazily so tests can set PI_PRIVACY_DIR before first use */
export function dataDir(): string {
  return process.env.PI_PRIVACY_DIR ?? join(homedir(), ".pi-privacy");
}
export function configFile(): string {
  return join(dataDir(), "privacy-router.json");
}

/** Keep for callers that read the path once (messages), not for path lookups. */
export const CONFIG_FILE_LABEL = "privacy-router.json";

export interface PrivacyConfig {
  localModel: { provider: string; model: string };
  withholdCategories: string[];
  redactCategories: string[];
  retryTimeoutSec: number;
  /** minimum span score for a span to count (A.20 calibration point) */
  spanConfidenceThreshold: number;
  /** reserved for the sensitivity head; not used in v1 predicates */
  sensitivityThreshold: number;
  /** "file:<path>" or "session:<id>" entries (A-3) */
  allowlist: string[];
}

export function defaultConfig(): PrivacyConfig {
  return {
    localModel: {
      provider: process.env.PI_PRIVACY_LOCAL_PROVIDER ?? "ollama",
      model: process.env.PI_PRIVACY_LOCAL_MODEL ?? "qwen2.5:3b",
    },
    withholdCategories: [...DEFAULT_WITHHOLD_CATEGORIES],
    redactCategories: [...DEFAULT_REDACT_CATEGORIES],
    retryTimeoutSec: 5,
    spanConfidenceThreshold: 0.5,
    sensitivityThreshold: 0.5,
    allowlist: [],
  };
}

export function loadConfig(): PrivacyConfig {
  const file = configFile();
  if (!existsSync(file)) return defaultConfig();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PrivacyConfig>;
    const d = defaultConfig();
    return {
      localModel: { ...d.localModel, ...(raw.localModel ?? {}) },
      withholdCategories: raw.withholdCategories ?? d.withholdCategories,
      redactCategories: raw.redactCategories ?? d.redactCategories,
      retryTimeoutSec: raw.retryTimeoutSec ?? d.retryTimeoutSec,
      spanConfidenceThreshold: raw.spanConfidenceThreshold ?? d.spanConfidenceThreshold,
      sensitivityThreshold: raw.sensitivityThreshold ?? d.sensitivityThreshold,
      allowlist: raw.allowlist ?? [],
    };
  } catch (e) {
    throw new Error(`privacy-router.json is not valid JSON: ${(e as Error).message}`);
  }
}

export function saveConfig(config: PrivacyConfig): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(config, null, 2) + "\n");
}

/** D-2: a config without a usable localModel blocks sensitive local analysis. */
export function isLocalModelValid(config: PrivacyConfig): boolean {
  return Boolean(config.localModel?.provider && config.localModel?.model);
}
