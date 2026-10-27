# pi-privacy-gate

**15 planted. 0 leaked.** A PII gate for [Pi](https://pi.dev), the coding agent: the machine
reads your private files, blackens every span, and only the blackened copy ever reaches the
cloud model.

[![demo](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/poster.jpg)](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/demo.mp4)

<sub>13-second demo — [watch the MP4](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/demo.mp4) or the [GIF](https://raw.githubusercontent.com/AlexMold/pi-privacy-gate/main/docs/media/demo.gif).</sub>

```
pi install npm:pi-privacy-gate
/privacy-setup
/privacy on
```

Cloud models keep orchestrating; private content never leaves your machine.
Inspired by Perplexity's Hybrid Compute. The detector is
[perplexity-ai/PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer) (MIT, 596M)
running through a self-managed `llama-server`. All decoding — tokenizer, heads, Viterbi —
is a pure-TypeScript port verified byte-exact against the reference client.

## Install

```bash
pi install npm:pi-privacy-gate    # or: pi install ./pi-privacy-gate for a local checkout
```

Then run the setup. It downloads the detector weights (~1.2 GB) and a platform
`llama-server` binary (12–22 MB), reusing anything already present:

```
/privacy-setup
/privacy-status
```

Supported platforms: macOS (arm64/x64), Linux (x64/arm64). Windows is out of scope for v1.

## Configure

`~/.pi-privacy/privacy-router.json` (defaults shown):

```json
{
  "localModel": { "provider": "ollama", "model": "qwen2.5:3b" },
  "cloudModel": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "withholdCategories": ["account_number", "secret", "private_address"],
  "redactCategories": ["private_person", "private_email", "private_phone", "private_url", "private_date", "other_pii"],
  "retryTimeoutSec": 5,
  "spanConfidenceThreshold": 0.5,
  "sensitivityThreshold": 0.5,
  "allowlist": []
}
```

- `localModel` — which registered Pi model handles private analysis. The **port is not
  configured here**: pi-privacy resolves `provider`/`model` through Pi's model registry.
  Declare where your local server listens in Pi first:
  - Ollama / LM Studio / vLLM / SGLang or any OpenAI-compatible server: add it to
    `~/.pi/agent/models.json` with its `baseUrl` (e.g. `http://localhost:11434/v1`),
    `api: "openai-completions"`, and your models — then reference the provider here.
  - llama.cpp router: `/login llama.cpp` (stores the URL) or `LLAMA_BASE_URL`/`LLAMA_API_KEY`
    environment variables.
- `detector` — how PII scanning is performed. Three modes:
  - `{ "mode": "managed", "port": 18080 }` (default): pi-privacy installs and supervises
    its own llama-server with the PII-Tracer weights (`/privacy-setup`). The **port** is
    `detector.port` in this file → `PI_PRIVACY_PORT` environment variable → `18080`.
    Changing it takes effect on the next session start — no re-setup needed.
  - `{ "mode": "http", "url": "http://127.0.0.1:8002/v1/scoring" }` — any HTTP endpoint that
    accepts `{"text": "..."}` and returns `{"spans": [{"start", "end", "label", "score"}]}`
    (char offsets). For example the PII-Tracer vLLM scoring adapter or your own service.
  - `{ "mode": "command", "command": "python3 ~/my_detector.py" }` — an arbitrary command:
    the text arrives on stdin, stdout must carry the same JSON shape. Works for a
    Python/transformers wrapper, an MLX script, or anything else you already run.

  Span output is validated (bounds clamped, labels checked) before it reaches the gate.
  With `http`/`command`, pi-privacy never starts or manages a detector process — that
  backend is entirely yours.
- `PI_PRIVACY_DIR` — where pi-privacy keeps its state (`~/.pi-privacy` by default:
  weights, llama-server binary, `state.json`, this config). Set it to relocate everything.

**Ports summary:** pi-privacy itself owns one port — the managed llama-server detector
(`detector.port` / `PI_PRIVACY_PORT`, default 18080). The local analysis model's port is
declared in Pi's provider configuration (`models.json` `baseUrl` or `/login llama.cpp`),
not in this file — pi-privacy calls it through Pi's model registry.
- `cloudModel` — fallback routing target for a fresh session with no prior responses. `/privacy on` keeps your current model (e.g. deepseek-v4-pro) as the orchestrator; private content goes to the local model inside `privacy_analyze`.
- `withholdCategories` — a tool result containing any span of these categories is withheld
  entirely: content is stored locally and the model sees only a placeholder.
- `redactCategories` — all other PII spans are replaced with `[REDACTED_category]`.
- `retryTimeoutSec` — how long the gate retries the local detector before failing closed.
- `spanConfidenceThreshold` — minimum span score for a detection to count.

## Use

```
/privacy on      # switch this session to pi-privacy/auto (gate active)
/privacy off     # back to the plain cloud model (gate inactive)
/privacy status  # is the gate active in this session?
```

While the gate is active:

- Every tool result is scanned locally before it enters context. Sensitive files are
  withheld; the cloud model can ask about them with the `privacy_analyze` tool, which
  runs the question on your **local** model and returns only a PII-redacted answer.
- PII in your messages is redacted before every provider request.
- If the detector is down, sensitive requests fail closed: they are blocked, never leaked.
- `/privacy-allow file:/path/to/file` or `/privacy-allow session:<id>` adds an explicit
  bypass for content you deliberately want processed by the cloud.

## What it does NOT protect

- **Injected context.** System prompt, memory, AGENTS.md, and skill content are added by
  Pi itself and are exempt from the gate. Whatever you put into your agent memory is sent
  to the cloud as-is.
- **Your local disk.** Pi stores transcripts locally. The gate protects egress to cloud
  providers, not files on your machine.
- **Image content in tool results.** v1 scans text blocks only.

## Latency

The detector runs in 1024-token windows (~0.35 ms/token on Apple Silicon + ~70 ms per
request). Large tool results add noticeable scan time; this is the cost of scanning
everything. See [docs/detector-spike-report.md](https://github.com/AlexMold/pi-privacy-gate/blob/main/docs/detector-spike-report.md) for measurements.

## Development

```bash
npm test          # unit tests + detector integration tests (skipped without llama-server)
```

## License

MIT. Detector weights: [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer), MIT.
