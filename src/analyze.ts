/**
 * privacy_analyze core (SPEC D-3): run a question against withheld content on the
 * LOCAL model, then re-scan the answer and redact PII before it can enter context.
 * DI-friendly for unit tests: complete/rescan injected.
 */

import { get } from "./store.ts";

export interface LocalModelRef {
  provider: string;
  model: string;
}

export type LocalCompleteFn = (modelRef: LocalModelRef, systemPrompt: string, userPrompt: string) => Promise<string>;
export type RescanFn = (text: string) => Promise<string>;

/** Interim local-model resolution; privacy-router.json wiring lands in M4. */
export function localModelFromEnv(): LocalModelRef {
  return {
    provider: process.env.PI_PRIVACY_LOCAL_PROVIDER ?? "ollama",
    model: process.env.PI_PRIVACY_LOCAL_MODEL ?? "qwen2.5:3b",
  };
}

export const ANALYZE_SYSTEM_PROMPT = [
  "You answer questions about a private document shown below.",
  "Answer factually and concisely from the document only.",
  "Never invent data that is not in the document.",
  "Quote values from the document exactly as written; do not compute derived values.",
].join("\n");

const NUM_RUN_RE = /[0-9][0-9.,$\s-]*[0-9]/g;
const MIN_NUM_RUN = 4;

/**
 * Layer-1 backstop for privacy_analyze answers (Scott's paraphrase gap): mask
 * literal numeric runs from the answer that also appear in the withheld source.
 * Covers what the span classifier misses (amounts, plain numbers). Does NOT
 * catch computed values absent from the source - that is a known limit, not a bug.
 */
export function diffMask(answer: string, doc: string): string {
  return answer.replace(NUM_RUN_RE, (run) =>
    run.length >= MIN_NUM_RUN && doc.includes(run) ? "[REDACTED_verbatim]" : run,
  );
}

export async function analyzeWithheld(
  fileRef: string,
  question: string,
  complete: LocalCompleteFn,
  rescan: RescanFn,
  modelRef: LocalModelRef = localModelFromEnv(),
): Promise<{ content: string; isError?: boolean }> {
  const entry = get(fileRef);
  if (!entry) {
    return { content: `pi-privacy: no withheld content with key "${fileRef}". Ask the user for the correct key.`, isError: true };
  }
  const answer = await complete(
    modelRef,
    ANALYZE_SYSTEM_PROMPT,
    `Private document:\n\n${entry.content}\n\nQuestion: ${question}`,
  );
  try {
    const masked = await rescan(answer);
    return { content: diffMask(masked, entry.content) };
  } catch (e) {
    // D-3 fail-closed: an unverified answer must not enter context
    return { content: `pi-privacy: could not verify the answer for PII (${(e as Error).message}); answer withheld.`, isError: true };
  }
}
