# Changelog

All notable changes to FlowLink will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles and this project uses semantic versioning.

## [Unreleased]

### Added

- **Recording:** Steps whose surviving target candidates are all structural selectors (no testid/role/label/text, only css-path/xpath level) are saved with `reviewRequired`/`reviewReason`, flagging replay-fragile steps at record time instead of discovering them after a failed replay; the flags also flow into AI refinement projections.
- **Recording:** Single-select dropdowns record as `select_N` Reference variables with the recorded value as default (multi-select keeps inline values), so replay-time dropdown choices are editable like text inputs.
- **Executor:** `isOptional` now applies to element steps too: when the target does not appear within a short wait, the step reports `skip` instead of failing, letting tolerant login groups absorb a remembered SSO session.
- **Pi:** AI takeover after a failed Test run: a one-click "Run remaining steps with AI" action hands the failed step and all remaining steps to a `@browser_use/pi` agent attached to the embedded browser (failure scene preserved); steps complete with an AI badge, progress lands in the AI pane chat, secrets flow through the SDK's redacting `sensitiveData` channel, and guardrails (domain allowlist from the flow, per-step retry, 10-minute budget, Stop) bound the run. The source Flow is never modified.
- **Pi:** Maintain every Pi prompt (session system prompt, auto-refine and refine generation, AI-pane advice) in `config/prompts.json` with `{{placeholder}}` templates; generation prompts now require business-stage grouping (2–6 labeled top-level groups) and plain-language step labels a non-technical user understands.
- **UI:** Make Service Levels 1–4 required cascading dropdowns backed by the process landscape.
- **Pi:** Auto-refine recordings after Stop: the main process generates a sanitized, stage-grouped `REFINED…` twin through the shared pipeline and reports it via toast; disable with `autoRefine: false` in `config/pi-settings.json`.
- **AI:** `@` mentions in the AI pane attach saved recordings of the current task to a message (autocomplete picker, removable chips); attachments flow into advice and refinement without ever putting flow JSON into the chat transcript.
- **AI:** The Refine button opens an options form (preset refinements plus free text) before generating a refined material from one or more analyzed recordings.
- **Recording:** Config-free navigation/SSO handling: auth-shaped redirects detected via built-in heuristics (no classification file to maintain) are recorded as `navigate` steps flagged `isOptional`, kept in the evidence stream, and resolved at replay — skipped when the browser has already redirected on its own, executed otherwise — so flows tolerate differing auth state between record and replay.
- **Recording:** HTML5 drag-and-drop records as replayable `drag` steps with resolved source/target element refs; unpaired, cross-tab, stale, or interrupted drags stay evidence-only, and drag steps get no inferred expectation in v1.
- **Pi:** Support a generic `custom` provider using `config/models.json` for private OpenAI-compatible endpoints.
- **Pi:** Support `--pi-system-proxy` and `--pi-proxy=<URL>` launch options for provider requests.
- **Recording:** Capture native tab opens, tab switches, and user-requested navigation while marking classified SSO/login redirects as optional steps; save recorded text inputs as Reference variables, marking password values secret.
- **Process:** Edit grouped flows with manual steps, waits, and assertion-based true/false branches; replay allows at most three visits per group.
- **Process:** Group operations beyond delete: rename, move up/down, and merge into the next group, all persisted through the validated `flow:updateSteps` contract with group numbering recomputed.
- **Process:** The manual step editor shows only the fields relevant to the chosen step type, offers element-based kinds only when the Flow has recorded elements to reference, no longer offers `script` steps, and surfaces save/contract errors inline while keeping the entered values for correction.
- **UI:** Group naming and workspace notices use styled in-app dialogs with inline validation instead of native `window.prompt`/`window.alert`.
- **UI:** Restore saved recordings into the Design tab after app restart.
- **UI:** Refine side pane with three mock options that dispatch to the existing merge flow.
- **UI:** "Auto" badge on every step in Process, Instruction, and Test views.
- **UI:** Sidebar "Automation rate -%" indicator with a light green background.
- **Recording:** Replay the required flow prefix before re-recording or inserting a process node, then preserve the resulting browser state and active tab.
- Repository documentation for English and Chinese users, architecture, contribution, agent development, and changelog maintenance.
- Windows Electron/Playwright application build and packaging workflow.
- Flow recording, replay, task persistence, element evidence, screenshots, dialogs, downloads, tabs, and iframe/frame support.

### Changed

- **Startup:** `npm start` / `npm run dev` now launch through a plain Node script (`scripts/start.mjs`) instead of the removed PowerShell launcher, so any shell (and coding agents) can start the app with the same flags (`--dev`, `--pi-system-proxy`, `--pi-proxy=<url>`; legacy spellings accepted); the launcher itself switches the Windows console code page to UTF-8 so Chinese logs stay readable in terminals and redirected output.
- **Recording:** Fingerprints no longer collect framework-internal attributes (`data-bind`, `data-reactid`, `data-v-*`, `ng-*`) or values containing line breaks, and the recorder backfills an approximate role/accessible name (implicit role from the tag, own text as name) when `ariaSnapshot` cannot supply one, so role+name candidates and a meaningful fingerprint exist even when the accessibility snapshot fails. Existing flows keep replaying: L2 attribute equality now compares the element's raw attribute values for the keys the recorded fingerprint supplies.
- **UI:** The Manual/Automated badge on Process canvas steps now marks step origin: recorded steps and steps added by users in the editor show Manual, while REFINED (AI-refined) flow steps show Automated.
- **UI:** Process, Instruction, and Test step text prefers the step's own label (AI-refined flows carry business-language labels) and otherwise renders Chinese phrases per operation type (点击 / 填写 / 选择 / 上传 …) instead of raw English kind names; the Instruction operation type is now a searchable picker styled like the Service Level selectors (search box, clear button, check mark on the selected option) limited to the supported step types, and fields without meaning for a type (target/value) are disabled.
- **Pi:** Auto-refined (`REFINED…`) workflows with a login segment now keep it as a gate condition plus a tolerant sign-in group (optional credential steps closed by an assert), so replays adapt to logged-in, expired, and remembered-SSO states; recorded value parameters (`input_N`/`select_N`/`password`/`file_N`) are preserved as templates, unknown variable references fail the generation, and unused variables no longer linger on the Reference page.
- **Startup:** The app prewarms the recording engine (CDP/Playwright attach) and the Pi runtime in the background after launch or when the AI pane opens, and no longer loads Playwright during cold start, cutting Record-click and first-AI-message latency; `[perf]` log lines now quantify cold start, Record start, and Pi prompt timings.
- **Recording:** Every session logs one `[perf] recording-session` summary (events received, batch failures, events requeued or dropped, capture reinjection attempts, popups never captured, pages attached/detached) to make stability issues measurable.
- **Recording:** Clicking Record no longer reloads the start URL when the embedded browser is already on it (hash differences ignored); the recording baseline is the current page, so use the browser toolbar reload first if a freshly loaded page is required.
- **UI:** Rebranded to the FlowLink green identity end to end: theme colors, header wordmark, navigation labels, and app title replace the previous blue/Taskflow look.
- **Packaging:** The window, taskbar, and packaged `FlowLink.exe` now show the FlowLink icon (multi-size `.ico` under `resources/`, verified by `package.mjs`); the renderer also ships an SVG favicon and logo under `renderer/assets/`.
- **UI:** Static page and panel structure (flow list rows, version rows, recording rows, analysis tabs, AI pane blocks) now lives in `renderer/index.html` templates that JavaScript fills, instead of being assembled from JS strings.
- **Recording:** Auth-shaped redirects (`sso_redirect`/`login_redirect`/`auto_redirect`) are retained in the raw evidence stream and the FlowForge sidecar with their navigation type; they never fold into the previous action's expectation and are kept out of the coalescer, so recorded click expectations are unchanged.
- **Flow:** Migrate existing schema v1 recordings to schema v2 for condition branches without changing their ordered replay behavior.
- **Storage:** Delete a recording's Flow and artifacts with the recording, remove all recordings' files when deleting a taskflow, and discard generated files when closing a new unsaved taskflow.

### Fixed

- **Replay:** Element resolution no longer fails with `AMBIGUOUS` when the page also contains hidden copies of the target (framework templates, stacked notifications): recorder-side candidate validation and replay-side L1/L2 resolution now share a "unique among visible elements" rule — several matches with exactly one visible resolve to that element, while several visible matches still require the geometric separation threshold; element wait readiness likewise requires a visible hit instead of any hit.
- **UI:** The embedded browser stays visible during replay: `playback:run` now restores the browser surface after the pre-replay tab reset (whose hide was never undone because unchanged bounds were deduplicated away), and hiding the browser invalidates the reported-rect cache so a same-size restore always re-reports.
- **Recording:** Event batches whose processing fails are retried once and otherwise kept in the evidence stream with their event IDs named in the warning, instead of being lost silently.
- **Recording:** A drag whose start and drop land in different capture flush windows (~500 ms apart) now records as one drag step instead of staying evidence-only.
- **Recording:** A tab that crashes or is closed mid-recording no longer breaks the session; its actions are skipped with a warning while the remaining tabs keep recording, and popups that cannot be captured are retried and reported.
- **Recording:** Stop no longer waits a fixed ~0.85 s for the capture video; it waits only for the in-flight frame plus one closing frame (hard-capped at 850 ms), so Stop returns quickly on fast machines without racing slow ones.
- **AI:** The Refine button no longer enables for (or silently ignores) selections that mix un-analyzed recordings; it now enables exactly when the selection is refinable and explains otherwise.
- **AI:** Refined-material generation no longer truncates source steps at 65k characters (which could yield unparseable output); oversized prompts now fail with a clear message, and generated steps are schema-validated in the main process with recorded element evidence rehydrated from an immutable `$ref` library.
- **Startup:** Load task-list metadata and recording counts first, then defer recording metadata and saved Flow detail hydration until its task drawer opens.
- **Pi:** Run SDK initialization and provider prompts in a worker thread so slow provider/proxy requests do not block the Electron main process.
- **AI:** Scroll recording context and conversation together, and retain chat history when the assistant pane is reopened.
- **Pi:** Load provider/model settings, apply the SDK system prompt with all tools disabled, and preserve provider errors instead of reporting only an empty response.
- **Startup:** Show the FlowLink window without waiting for the initial browser page's network response.
- **Pi:** Defer SDK loading until Pi is used and honor environment-configured HTTP proxies for provider requests.
- **Replay:** Create new tabs through native Electron views instead of unsupported CDP `Target.createTarget` calls.
- **Test:** Reset to one fresh browser on every Test entry and await recording cleanup before restarting.
- **Recording:** Avoid native-view loading flashes and unnecessary browser chrome/dock recreation.
- **UI:** Keep workspace confirmations visible above the native browser and reserve space for the floating AI dock in every Design state.
- **Recording:** Persist native tab creation and its first navigation as one replayable `openTab` action.
- **Recording:** Cancel empty or still-starting recordings cleanly without blocking Stop or creating empty records and capture artifacts.
- **UI:** Wrap long Process URLs and require one confirmation for profile Save and drawer Close actions.
- **Development:** Launch Windows terminals with UTF-8 input/output so Chinese logs remain readable.

### Security

- Storage-state handling preserves raw or wrapped profile shapes and treats credentials as sensitive data.
