/**
 * pi-privacy — privacy gate for Pi.
 * M1: /privacy-setup + supervisor. M2: tool_result withhold/redact + context redaction.
 * M3: privacy_analyze on the local model. M4: privacy-router.json, fail-closed, allowlist.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setup, ensureRunning, stopServer, loadState, isHealthy } from "../src/server.ts";
import { PiiDetector } from "../src/detector.ts";
import { PrivacyGate, placeholderText } from "../src/gate.ts";
import { put } from "../src/store.ts";
import { analyzeWithheld } from "../src/analyze.ts";
import { maskText } from "../src/viterbi.ts";
import { loadConfig, saveConfig, isLocalModelValid, configFile, type PrivacyConfig } from "../src/config.ts";
import { HttpScanner, CommandScanner, type SpanScanner } from "../src/scanners.ts";

let detector: SpanScanner | null = null;
let gate: PrivacyGate | null = null;
let config: PrivacyConfig | null = null;
/** per-session: physical model in use right before /privacy on — route fallback and /privacy off target */
const preOnModels = new Map<string, { provider: string; id: string }>();

function initGate(): PrivacyGate | null {
  const state = loadState();
  if (!config) {
    try {
      config = loadConfig();
    } catch (e) {
      console.error(`pi-privacy: ${(e as Error).message}`);
      return null;
    }
  }
  const mode = config.detector.mode;
  if (mode === "managed" && !state) return null; // not installed yet
  if (!gate) {
    try {
      detector = buildScanner(config, state);
      gate = new PrivacyGate((text) => detector!.scan(text), {
        withholdCategories: config.withholdCategories,
        redactCategories: config.redactCategories,
        spanConfidenceThreshold: config.spanConfidenceThreshold,
        retryTimeoutSec: config.retryTimeoutSec,
      });
    } catch (e) {
      console.error(`pi-privacy: gate unavailable: ${(e as Error).message}`);
      return null;
    }
  }
  return gate;
}

/** Detector backend selection (SPEC design tree #4): managed / http / command. */
function buildScanner(cfg: PrivacyConfig, state: ReturnType<typeof loadState>): SpanScanner {
  const d = cfg.detector;
  if (d.mode === "http") return new HttpScanner(d.url, d.timeoutMs);
  if (d.mode === "command") return new CommandScanner(d.command, d.timeoutMs);
  if (!state) throw new Error("detector.mode is \"managed\" but the detector is not installed. Run /privacy-setup");
  return new PiiDetector(state.weightsDir, `http://127.0.0.1:${state.port}`);
}

/** A-3: session- or file-level allowlist bypass. */
function isAllowed(ctx: { sessionManager: { getSessionId(): string } }, input: Record<string, unknown>): boolean {
  if (!config) return false;
  const sessionId = ctx.sessionManager.getSessionId();
  if (config.allowlist.includes(`session:${sessionId}`)) return true;
  const path = input.path;
  if (typeof path === "string" && config.allowlist.includes(`file:${path}`)) return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  /** M5: gate is active only when the session model is privacy/auto (design tree #12). */
  const gateActive = (ctx: { model?: { provider?: string; id?: string } }) =>
    ctx.model?.provider === "pi-privacy" && ctx.model?.id === "auto";

  pi.registerVirtualModel({
    provider: "pi-privacy",
    id: "auto",
    name: "Privacy Auto",
    thinkingLevels: ["off", "low", "medium", "high"],
    route(request, ctx) {
      // Keep the user's current model as the orchestrator (e.g. deepseek-v4-pro):
      // /privacy on just adds the gate around whatever model the session already uses.
      const prev = request.previous;
      if (prev && prev.model.provider !== "pi-privacy") {
        return { model: prev.model, thinkingLevel: prev.thinkingLevel ?? request.thinkingLevel };
      }
      // No responses yet in this session: the model captured at /privacy on time.
      const preOn = preOnModels.get(ctx.sessionManager.getSessionId());
      if (preOn) {
        const model = ctx.modelRegistry.find(preOn.provider, preOn.id);
        if (model) return { model, thinkingLevel: request.thinkingLevel };
      }
      // Fresh session selected via /model without /privacy on: configured fallback.
      const cfg = loadConfig();
      const { provider, model: id } = cfg.cloudModel;
      if (!provider || !id) {
        throw new Error(`pi-privacy: no previous model in this session and cloudModel not set in ${configFile()}. Add {"cloudModel": {"provider": "<provider>", "model": "<model>"}}`);
      }
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) throw new Error(`pi-privacy: cloud model ${provider}/${id} not in the catalog`);
      return { model, thinkingLevel: request.thinkingLevel };
    },
  });

  pi.registerCommand("privacy", {
    description: "Enable/disable the privacy gate in this session: /privacy on|off",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      const virtual = ctx.modelRegistry.find("pi-privacy", "auto");
      if (!virtual) { ctx.ui.notify("pi-privacy: virtual model pi-privacy/auto not registered", "error"); return; }
      if (sub === "on") {
        // remember the physical model so route() and /privacy off can return to it
        const current = ctx.model;
        if (current && current.provider !== "pi-privacy") {
          preOnModels.set(ctx.sessionManager.getSessionId(), { provider: current.provider, id: current.id });
        }
        await pi.setModel(virtual);
        ctx.ui.notify("pi-privacy: gate ON — continuing on your current model; private content goes local", "info");
      } else if (sub === "off") {
        if (!gateActive(ctx)) {
          const cur = ctx.model;
          preOnModels.delete(ctx.sessionManager.getSessionId());
          ctx.ui.notify(`pi-privacy: gate is not active (session model: ${cur ? `${cur.provider}/${cur.id}` : "none"}). Nothing to turn off.`, "info");
          return;
        }
        const sessionId = ctx.sessionManager.getSessionId();
        const preOn = preOnModels.get(sessionId);
        let target = preOn ? ctx.modelRegistry.find(preOn.provider, preOn.id) : undefined;
        if (!target) {
          const cfg = loadConfig();
          target = cfg.cloudModel.provider && cfg.cloudModel.model
            ? ctx.modelRegistry.find(cfg.cloudModel.provider, cfg.cloudModel.model)
            : undefined;
        }
        if (!target) { ctx.ui.notify("pi-privacy: cannot switch off — no model to return to", "error"); return; }
        await pi.setModel(target);
        preOnModels.delete(sessionId);
        ctx.ui.notify(`pi-privacy: gate OFF — back on ${target.provider}/${target.id}`, "info");
      } else if (sub === "status" || sub === "") {
        const active = gateActive(ctx);
        ctx.ui.notify(`pi-privacy: gate ${active ? "ON (pi-privacy/auto)" : "OFF"}`, "info");
      } else {
        ctx.ui.notify("pi-privacy: usage — /privacy on|off|status", "warning");
      }
    },
  });

  /** M5: switching the model away from privacy/auto turns the gate off — make it visible. */
  pi.on("model_select", async (event, ctx) => {
    const wasActive = event.previousModel?.provider === "pi-privacy" && event.previousModel?.id === "auto";
    if (wasActive && !gateActive(ctx)) {
      preOnModels.delete(ctx.sessionManager.getSessionId());
      ctx.ui.notify(`pi-privacy: gate OFF — model switched to ${event.model.provider}/${event.model.id}`, "info");
    }
  });

  pi.registerCommand("privacy-setup", {
    description: "Install and start the pi-privacy PII detector (weights + llama-server)",
    handler: async (_args, ctx) => {
      try {
        const cfg = loadConfig();
        if (cfg.detector.mode !== "managed") {
          ctx.ui.notify(`pi-privacy: detector.mode is "${cfg.detector.mode}" — the managed llama-server is not used. Nothing to set up.`, "info");
          return;
        }
        const state = await setup();
        ctx.ui.notify(`pi-privacy: detector running on port ${state.port} (llama.cpp ${state.version})`, "info");
      } catch (e) {
        ctx.ui.notify(`pi-privacy setup failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("privacy-status", {
    description: "Show pi-privacy detector and config state",
    handler: async (_args, ctx) => {
      let cfg: PrivacyConfig;
      try {
        cfg = loadConfig();
      } catch (e) {
        ctx.ui.notify(`pi-privacy: ${(e as Error).message}`, "error");
        return;
      }
      const d = cfg.detector;
      if (d.mode === "managed") {
        const state = loadState();
        if (!state) { ctx.ui.notify("pi-privacy: not installed. Run /privacy-setup", "warning"); return; }
        const healthy = await isHealthy(state.port);
        ctx.ui.notify(`pi-privacy: detector ${healthy ? "running" : "DOWN"} (managed llama-server, port ${state.port})`, healthy ? "info" : "warning");
      } else if (d.mode === "http") {
        ctx.ui.notify(`pi-privacy: detector http → ${d.url}`, "info");
      } else {
        ctx.ui.notify(`pi-privacy: detector command → ${d.command}`, "info");
      }
      if (!isLocalModelValid(cfg)) {
        ctx.ui.notify(`pi-privacy: ${configFile()} has no valid localModel — privacy_analyze is blocked (D-2)`, "warning");
      }
      ctx.ui.notify(`pi-privacy: gate ${gateActive(ctx) ? "ON" : "OFF"} in this session`, "info");
    },
  });

  pi.registerCommand("privacy-allow", {
    description: "Allowlist a file or session to bypass the gate: /privacy-allow file:<path> | session:<id>",
    handler: async (args, ctx) => {
      try {
        const cfg = loadConfig();
        const raw = args.trim();
        const entry = raw.includes(":") && raw.startsWith("session:") ? raw : `file:${raw}`;
        if (!cfg.allowlist.includes(entry)) {
          cfg.allowlist.push(entry);
          saveConfig(cfg);
          config = null; // re-read on next initGate
          ctx.ui.notify(`pi-privacy: allowlisted ${entry}`, "info");
        } else {
          ctx.ui.notify(`pi-privacy: ${entry} already allowlisted`, "info");
        }
      } catch (e) {
        ctx.ui.notify(`pi-privacy allow failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.on("session_start", async () => {
    let cfg: PrivacyConfig | null = null;
    try {
      cfg = loadConfig();
    } catch { /* config errors surface via commands */ }
    // Only the managed backend owns a process; http/command backends are the user's.
    if (!cfg || cfg.detector.mode === "managed") {
      const ok = await ensureRunning();
      if (ok) initGate();
    } else {
      initGate();
    }
    if (cfg && !isLocalModelValid(cfg)) {
      console.error(`pi-privacy: ${configFile()} has no valid localModel — privacy_analyze blocked until fixed (D-2)`);
    }
  });

  pi.on("session_shutdown", () => {
    stopServer();
  });

  /** M2/M4: withhold or redact tool results before they enter context (SPEC A-1/A-2, D-1). */
  pi.on("tool_result", async (event, ctx) => {
    if (!gateActive(ctx)) return undefined;
    const g = initGate();
    if (!g) return undefined;
    if (isAllowed(ctx, event.input)) return undefined;
    const textBlocks = event.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
    if (textBlocks.length === 0) return undefined;
    const full = textBlocks.map((b) => b.text).join("\n");

    let decision;
    try {
      decision = await g.decide(full); // retries internally (D-1)
    } catch (e) {
      // detector down after retries: fail-closed — withhold instead of leaking
      const key = put({ toolCallId: event.toolCallId, toolName: event.toolName, content: full, categories: ["detector_down"] });
      ctx.ui.notify(`pi-privacy: detector unavailable (${(e as Error).message}) — tool result withheld (key ${key})`, "warning");
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

  /** M2/M4: redact PII spans in user messages before each provider request; block when detector is down (D-1). */
  pi.on("context", async (event, ctx) => {
    if (!gateActive(ctx)) return undefined;
    const g = initGate();
    if (!g) return undefined;
    const messages = [];
    for (const msg of event.messages) {
      if (msg.role !== "user") { messages.push(msg); continue; }
      const content = msg.content;
      if (typeof content !== "string") { messages.push(msg); continue; }
      try {
        const decision = await g.decide(content); // retries internally (D-1)
        messages.push(decision.action === "redact" ? { ...msg, content: decision.masked! } : msg);
      } catch (e) {
        // fail-closed: replace the message so the request does not carry unverified content
        messages.push({ ...msg, content: `[pi-privacy: request blocked — PII detector unavailable (${(e as Error).message}). Run /privacy-status.]` });
        ctx.ui.notify("pi-privacy: request blocked — detector unavailable", "warning");
      }
    }
    return { messages };
  });

  /** M3/M4: local-model analysis of withheld content; answer re-scanned before entering context (D-3). */
  pi.registerTool({
    name: "privacy_analyze",
    label: "Privacy Analyze",
    description: "Ask the local model a question about a withheld private file (referenced by its store key from the placeholder). Private content never leaves this machine; only the PII-redacted answer returns to the conversation.",
    parameters: Type.Object({
      question: Type.String({ description: "Question about the withheld file" }),
      fileRef: Type.String({ description: "Store key from the withheld placeholder" }),
    }),
    annotations: { readOnlyHint: true },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const g = initGate();
      if (!g || !detector) {
        return { content: [{ type: "text", text: "pi-privacy: detector not installed. Run /privacy-setup first." }], details: undefined, isError: true };
      }
      if (!config || !isLocalModelValid(config)) {
        // D-2: instructive block
        return {
          content: [{ type: "text", text: `pi-privacy: no valid localModel in ${configFile()}. Add {\"localModel\": {\"provider\": \"<provider>\", \"model\": \"<model>\"}} and reload. Private content was NOT sent anywhere.` }],
          details: undefined,
          isError: true,
        };
      }
      const modelRef = config.localModel;
      const complete = async (ref: { provider: string; model: string }, system: string, user: string): Promise<string> => {
        let model = ctx.modelRegistry.find(ref.provider, ref.model);
        if (!model) {
          // stale catalog (e.g. models.json drift): refresh once, then retry
          try { await ctx.modelRegistry.refresh(); model = ctx.modelRegistry.find(ref.provider, ref.model); } catch { /* keep original error */ }
        }
        if (!model) throw new Error(`local model ${ref.provider}/${ref.model} not found in the model registry`);
        const resp = await ctx.modelRegistry.streamSimple(model, { systemPrompt: system, messages: [{ role: "user", content: user }] }).result();
        const content = resp.content;
        return typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      };
      const rescan = async (text: string): Promise<string> => {
        const res = await detector.scan(text);
        return maskText(text, res.spans);
      };
      try {
        const result = await analyzeWithheld(params.fileRef, params.question, complete, rescan, modelRef);
        return { content: [{ type: "text", text: result.content }], details: undefined, isError: result.isError };
      } catch (e) {
        // local model unavailable — fail-closed (D-2)
        return { content: [{ type: "text", text: `pi-privacy: local analysis failed: ${(e as Error).message}. The private content was NOT sent anywhere.` }], details: undefined, isError: true };
      }
    },
  });
}
