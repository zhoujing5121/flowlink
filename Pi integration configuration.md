# Pi integration configuration

For a straightforward setup, users should only need to provide **provider, model, and API key**. Make the rest optional and use sensible defaults.

| Field | Required? | Guidance |
|---|---:|---|
| **Provider** | Yes | A provider supported by Pi, such as OpenCode or OpenAI. Use a provider picker where possible. |
| **Model** | Yes | The exact model ID for that provider; ideally populate this from the provider’s available models. |
| **API key** | Usually | Masked secret input. Some providers may instead use sign-in or another credential method. |
| **Base URL** | Optional | Only for custom or OpenAI-compatible endpoints. The current integration selects models through Pi’s provider/model catalog, so custom endpoint support would need to be implemented and validated. |
| **Proxy** | Optional | Proxy URL if users need one. The current setup uses `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables rather than an in-app proxy field. |
| **Thinking level** | Optional | Off, low, medium, or high. Already supported by the Pi settings. |
| **Request timeout** | Optional | Default to 120 seconds; allow a bounded range. Already supported. |
| **Temperature / max output tokens** | Optional | Expose only if supported for the selected provider/model and actually passed through to the SDK; don’t show settings that have no effect. |

For a better setup flow, offer a **Test connection** button that makes a small provider request and distinguishes invalid credentials, unknown model, and network/proxy failures.

## Prompt templates

All Pi prompts live in `config/prompts.json` as `{{placeholder}}` templates and are loaded at request time (no restart needed after edits):

| Section | Used by | Notes |
|---|---|---|
| `systemPrompt` | Every Pi session (worker system prompt) | Safety rules, JSON output contract, element `$ref` rules. |
| `generation.autoSanitize` | Auto-refine after recording Stop | Sanitize + business-stage grouping + plain-language labels. |
| `generation.refine` | Refine button / `@`-mention generation | Same goals, driven by the user instruction. |
| `advice.prompt` | AI-pane advice requests | Assembled in the renderer via the `pi:promptTemplates` IPC. |
| `advice.defaults` | Post-recording / replay-failure / manual review entry points | Default request texts. |
| `takeover.systemInstructions` / `takeover.stepTask` / `takeover.retryTask` | AI takeover after a failed Test run (`src/ai-takeover.ts`) | Capability list (browser-use primitives, `mark_step_done`, `get_step_detail`, `fillSecret`), evidence rules, per-step task and retry texts. |

Generation prompts require the model to group steps into a small number (typically 2–6) of labeled top-level groups by business stage and to write step labels a non-technical user understands (no selectors or jargon). Unknown placeholders or missing values fail loudly instead of silently producing a broken prompt.

The takeover agent uses the same provider/model as the rest of Pi (`pi-settings.json`; `custom` providers additionally need a `baseUrl` in `config/models.json`). Its JS worker prefers a system Node ≥22.19 on PATH and falls back to the Electron binary; anonymous SDK telemetry is disabled by default.
