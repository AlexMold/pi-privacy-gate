import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// isolate before importing server.ts (DATA_DIR is read at module init)
const TEST_DIR = join(tmpdir(), `pi-privacy-port-${process.pid}-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });
process.env.PI_PRIVACY_DIR = TEST_DIR;
delete process.env.PI_PRIVACY_PORT;

const { detectorPort } = await import("../src/server.ts");

test("default port is 18080", () => {
  rmSync(join(TEST_DIR, "privacy-router.json"), { force: true });
  assert.equal(detectorPort(), 18080);
});

test("detector.port from privacy-router.json wins", () => {
  writeFileSync(join(TEST_DIR, "privacy-router.json"), JSON.stringify({ detector: { mode: "managed", port: 9099 } }));
  assert.equal(detectorPort(), 9099);
});

test("PI_PRIVACY_PORT env is used when config has no port", () => {
  writeFileSync(join(TEST_DIR, "privacy-router.json"), JSON.stringify({ detector: { mode: "managed" } }));
  process.env.PI_PRIVACY_PORT = "9077";
  assert.equal(detectorPort(), 9077);
  delete process.env.PI_PRIVACY_PORT;
});

test("invalid values fall back to default", () => {
  writeFileSync(join(TEST_DIR, "privacy-router.json"), JSON.stringify({ detector: { port: 99999 } }));
  assert.equal(detectorPort(), 18080);
  writeFileSync(join(TEST_DIR, "privacy-router.json"), "broken {");
  assert.equal(detectorPort(), 18080);
  rmSync(join(TEST_DIR, "privacy-router.json"), { force: true });
});
