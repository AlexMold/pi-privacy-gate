/**
 * Test-only extension for the egress proof (SPEC E-4). Loaded via `pi -e` alongside
 * pi-privacy-gate. Captures the serialized provider payload of every outbound request
 * to EGRESS_CAPTURE_DIR, and refreshes the model registry at session start so a local
 * Ollama model that the stale catalog misses is routable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  // The egress run targets local Ollama models that a stale models.json catalog may not
  // list; register a dedicated local provider for this session so route() can find them.
  // Guarded: registering a provider while a virtual model is preselected via --model
  // crashes pi at startup (repro: pi -e . -e <registrar> --model pi-privacy/auto), so
  // the egress run enables this via EGRESS_REGISTER=1 and selects the model via /privacy on.
  if (process.env.EGRESS_REGISTER === "1") {
    try {
      pi.registerProvider("egress-local", {
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        compat: { supportsDeveloperRole: false },
        models: [{ id: "qwen2.5:3b" }, { id: "qwen3.6:35b-a3b-q4_K_M" }],
      });
    } catch { /* already registered */ }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Select the virtual model AFTER startup: preselecting it via --model while another
    // extension registers a provider crashes pi at startup (see comment above).
    if (process.env.EGRESS_SELECT === "1") {
      const virtual = ctx.modelRegistry.find("pi-privacy", "auto");
      if (virtual) await pi.setModel(virtual);
    }
    try { await ctx.modelRegistry.refresh(); } catch { /* best-effort */ }
  });

  pi.on("before_provider_request", async (event) => {
    const dir = process.env.EGRESS_CAPTURE_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const n = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`${dir}/payload-${n}-${Math.random().toString(36).slice(2, 8)}.json`, JSON.stringify(event.payload, null, 2));
  });
}
