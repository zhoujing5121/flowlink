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
