import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// isolate BEFORE importing config (dataDir() reads env lazily)
const TEST_DIR = join(tmpdir(), `pi-privacy-test-${process.pid}-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });
process.env.PI_PRIVACY_DIR = TEST_DIR;

const { defaultConfig, loadConfig, saveConfig, isLocalModelValid, configFile } = await import("../src/config.ts");

test("loadConfig returns defaults when file absent", () => {
  const cfg = loadConfig();
  assert.equal(cfg.localModel.provider, "ollama");
  assert.equal(cfg.retryTimeoutSec, 5);
  assert.ok(cfg.withholdCategories.includes("account_number"));
  assert.deepEqual(cfg.allowlist, []);
});

test("save/load roundtrip with overrides", () => {
  const cfg = defaultConfig();
  cfg.localModel = { provider: "llama.cpp", model: "qwen3-8b" };
  cfg.retryTimeoutSec = 3;
  cfg.spanConfidenceThreshold = 0.7;
  cfg.allowlist = ["file:/Users/alex/bank.csv"];
  saveConfig(cfg);
  const loaded = loadConfig();
  assert.equal(loaded.localModel.provider, "llama.cpp");
  assert.equal(loaded.localModel.model, "qwen3-8b");
  assert.equal(loaded.retryTimeoutSec, 3);
  assert.equal(loaded.spanConfidenceThreshold, 0.7);
  assert.deepEqual(loaded.allowlist, ["file:/Users/alex/bank.csv"]);
});

test("partial file merges onto defaults", () => {
  const cfg = defaultConfig();
  cfg.withholdCategories = ["secret"];
  saveConfig(cfg);
  const loaded = loadConfig();
  assert.deepEqual(loaded.withholdCategories, ["secret"]);
  assert.equal(loaded.redactCategories.length, defaultConfig().redactCategories.length);
});

test("isLocalModelValid (D-2)", () => {
  const cfg = defaultConfig();
  assert.ok(isLocalModelValid(cfg));
  cfg.localModel = { provider: "", model: "" };
  assert.ok(!isLocalModelValid(cfg));
  cfg.localModel = { provider: "ollama", model: "" };
  assert.ok(!isLocalModelValid(cfg));
});

test("invalid JSON throws instructive error", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const original = readFileSync(configFile(), "utf8");
  writeFileSync(configFile(), "{ not json");
  assert.throws(() => loadConfig(), /not valid JSON/);
  writeFileSync(configFile(), original);
  assert.ok(isLocalModelValid(loadConfig()));
});
