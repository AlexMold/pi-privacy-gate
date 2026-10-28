# pi-privacy-gate

[![npm](https://img.shields.io/npm/v/pi-privacy-gate)](https://www.npmjs.com/package/pi-privacy-gate)

**15 planted. 0 leaked.**

Your coding agent reads a bank statement, a medical note, a `.env`. This gate blackens
every private span on your machine first — the cloud model only ever sees the bars.

![pi-privacy-gate demo](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/demo.gif)

<sub>[13-second MP4](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/demo.mp4) · the numbers come from a real run: [`npm run egress:proof`](scripts/egress-proof.ts) plants 15 secrets, captures the outbound request byte for byte, and finds none of them.</sub>

```bash
pi install npm:pi-privacy-gate
/privacy-setup      # downloads the local detector, ~1.2 GB, once
/privacy on         # gate this session
```

Works on macOS and Linux. Windows is not supported yet.

## What happens when the gate is on

You keep working with your usual model. Nothing about your setup changes except one thing:
files are read on your machine before they travel.

| You ask | What the agent gets |
| --- | --- |
| "summarise this invoice" | the invoice, with the account number replaced by a black bar |
| "what's my balance" | a placeholder, then the question runs on your **local** model and only a redacted answer comes back |
| "read my medical note" | the note never leaves; the cloud sees "withheld" and can ask questions about it |

If the detector is not running, the request is **blocked** — never sent unredacted.

```
/privacy on       gate this session (keeps your current model)
/privacy off      back to plain
/privacy status   what is active
```

## Configure

Everything lives in `~/.pi-privacy/privacy-router.json`. Two settings are worth your
attention; the rest has sane defaults.

**Which local model answers private questions.** Use whatever Pi already knows —
Ollama, LM Studio, llama.cpp, vLLM. Point it at a provider and model, and make sure the
server is declared in Pi first (`~/.pi/agent/models.json` with its `baseUrl`, or
`/login llama.cpp`):

```json
"localModel": { "provider": "ollama", "model": "qwen3:8b" }
```

**Which files are too private to send at all.** A file matching these categories is
withheld whole, not just redacted:

```json
"withholdCategories": ["account_number", "secret", "private_address"]
```

Everything else it finds — names, emails, phones, dates, URLs — is blackened in place and
the rest of the file still reaches the model.

<details>
<summary>All settings, and using your own detector</summary>

```json
{
  "detector":           { "mode": "managed", "port": 18080 },
  "localModel":         { "provider": "ollama", "model": "qwen2.5:3b" },
  "cloudModel":         { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "withholdCategories": ["account_number", "secret", "private_address"],
  "redactCategories":   ["private_person", "private_email", "private_phone", "private_url", "private_date", "other_pii"],
  "retryTimeoutSec": 5,
  "spanConfidenceThreshold": 0.5,
  "allowlist": []
}
```

- `cloudModel` — only used when a session has no history yet. Otherwise `/privacy on` keeps
  the model you were already using.
- `retryTimeoutSec` — how long to wait for the detector before failing closed.
- `spanConfidenceThreshold` — how sure the detector must be before it acts.
- `allowlist` — filled by `/privacy-allow file:/path` or `/privacy-allow session:<id>`.

**Your own detector.** By default the gate runs PII-Tracer through a `llama-server` it
installs and supervises itself. If you already run something else, point it at it and the
gate stops managing any process:

```jsonc
// a service: POST {"text": "..."} -> {"spans": [{"start", "end", "label", "score"}]}
"detector": { "mode": "http", "url": "http://127.0.0.1:8002/v1/scoring" }

// a script: text on stdin, same JSON on stdout
"detector": { "mode": "command", "command": "python3 ~/my_detector.py" }
```

Span offsets are clamped and labels validated before anything is trusted. The managed
detector's port is `detector.port` → `PI_PRIVACY_PORT` → `18080`.

`PI_PRIVACY_DIR` relocates all state (`~/.pi-privacy` by default: weights, binary, config).

</details>

## What it does not protect

- **Context Pi injects.** Memory, AGENTS.md and skills are sent as-is. Whatever you put in
  your agent's memory goes to the cloud.
- **Your disk.** The gate guards the way out, not the files on your machine.
- **Images in tool results.** v1 scans text only.
- **Paraphrase and computed values.** The detector finds PII spans, not meaning. If a
  question about a withheld file produces a *derived* answer ("the total minus tax" =
  a number the document never contains), no span classifier can catch it. `privacy_analyze`
  adds a verbatim-diff backstop for numbers quoted from the file, and the local model is
  told to quote, not compute — but a determined paraphrase is out of scope for v1.

Scanning costs time: about 0.35 ms per token in 1024-token windows. A large file adds a
second or two. [Measurements](https://github.com/AlexMold/pi-privacy-gate/blob/main/docs/detector-spike-report.md).

## Under the hood

The detector is [perplexity-ai/PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer)
(MIT, 596M) — nine PII categories, local inference. The tokenizer, the two heads and the
BIOES Viterbi decoder are a pure-TypeScript port, verified byte-exact against the reference
client, so no Python is needed. Inspired by Perplexity's Hybrid Compute.

```bash
npm test           # 49 tests; detector tests skip without a running llama-server
npm run egress:proof   # replant 15 secrets and prove none escapes
```

MIT. Detector weights: MIT, same upstream.
