/**
 * pi-privacy — privacy gate for Pi.
 * M1: /privacy-setup + supervisor. M2: tool_result withhold/redact + context redaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setup, ensureRunning, stopServer, loadState, isHealthy } from "../src/server.ts";
import { PiiDetector } from "../src/detector.ts";
import { PrivacyGate, placeholderText } from "../src/gate.ts";
import { put } from "../src/store.ts";

let detector: PiiDetector | null = null;
let gate: PrivacyGate | null = null;

function initGate(): PrivacyGate | null {
  const state = loadState();
  if (!state || !gate) {
    try {
      if (!state) return null;
      detector = new PiiDetector(state.weightsDir, `http://127.0.0.1:${state.port}`);
      gate = new PrivacyGate((text) => detector!.scan(text));
    } catch (e) {
      console.error(`pi-privacy: gate unavailable: ${(e as Error).message}`);
      return null;
    }
  }
  return gate;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("privacy-setup", {
    description: "Install and start the pi-privacy PII detector (weights + llama-server)",
    handler: async (_args, ctx) => {
      try {
        const state = await setup();
        ctx.ui.notify(`pi-privacy: detector running on port ${state.port} (llama.cpp ${state.version})`, "info");
      } catch (e) {
        ctx.ui.notify(`pi-privacy setup failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("privacy-status", {
    description: "Show pi-privacy detector state",
    handler: async (_args, ctx) => {
      const state = loadState();
      if (!state) { ctx.ui.notify("pi-privacy: not installed. Run /privacy-setup", "warning"); return; }
      const healthy = await isHealthy(state.port);
      ctx.ui.notify(`pi-privacy: ${healthy ? "running" : "DOWN"} (port ${state.port}, weights ${state.weightsDir})`, healthy ? "info" : "warning");
    },
  });

  pi.on("session_start", async () => {
    const ok = await ensureRunning();
    if (ok) initGate();
  });

  pi.on("session_shutdown", () => {
    stopServer();
  });

  /** M2: withhold or redact tool results before they enter context (SPEC A-1/A-2). */
  pi.on("tool_result", async (event, ctx) => {
    const g = initGate();
    if (!g) return undefined;
    const textBlocks = event.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
    if (textBlocks.length === 0) return undefined;
    const full = textBlocks.map((b) => b.text).join("\n");

    let decision;
    try {
      decision = await g.decide(full);
    } catch (e) {
      // detector down: fail-safe — withhold instead of leaking (D-1 full version in M4)
      const key = put({ toolCallId: event.toolCallId, toolName: event.toolName, content: full, categories: ["detector_down"] });
      ctx.ui.notify(`pi-privacy: detector unavailable — tool result withheld (key ${key})`, "warning");
      return { content: [{ type: "text", text: placeholderText(key, full.length, ["detector_down"]) }] };
    }

    if (decision.action === "pass") return undefined;

    if (decision.action === "withhold") {
      const key = put({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: full,
        categories: decision.categories,
      });
      ctx.ui.notify(`pi-privacy: tool result withheld (${decision.categories.join(", ")})`, "info");
      return { content: [{ type: "text", text: placeholderText(key, full.length, decision.categories) }] };
    }

    ctx.ui.notify(`pi-privacy: ${decision.spans.length} PII span(s) redacted`, "info");
    return { content: [{ type: "text", text: decision.masked! }] };
  });

  /** M2: redact PII spans in user messages before each provider request (provider-agnostic). */
  pi.on("context", async (event) => {
    const g = initGate();
    if (!g) return undefined;
    const messages = [];
    for (const msg of event.messages) {
      if (msg.role !== "user") { messages.push(msg); continue; }
      const content = msg.content;
      if (typeof content !== "string") { messages.push(msg); continue; }
      try {
        const decision = await g.decide(content);
        messages.push(decision.action === "redact" ? { ...msg, content: decision.masked! } : msg);
      } catch {
        messages.push(msg); // detector down: user-message blocking lands in M4 (D-1)
      }
    }
    return { messages };
  });
}
