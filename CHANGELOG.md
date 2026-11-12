# Changelog

All notable changes to FlowLink will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) principles and this project uses semantic versioning.

## [Unreleased]

### Added

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
- **UI:** Restore saved recordings into the Design tab after app restart.
- **UI:** Refine side pane with three mock options that dispatch to the existing merge flow.
- **UI:** "Auto" badge on every step in Process, Instruction, and Test views.
- **UI:** Sidebar "Automation rate -%" indicator with a light green background.
- **Recording:** Replay the required flow prefix before re-recording or inserting a process node, then preserve the resulting browser state and active tab.
- Repository documentation for English and Chinese users, architecture, contribution, agent development, and changelog maintenance.
- Windows Electron/Playwright application build and packaging workflow.
- Flow recording, replay, task persistence, element evidence, screenshots, dialogs, downloads, tabs, and iframe/frame support.

### Changed

- **Startup:** The app prewarms the recording engine (CDP/Playwright attach) and the Pi runtime in the background after launch or when the AI pane opens, and no longer loads Playwright during cold start, cutting Record-click and first-AI-message latency; `[perf]` log lines now quantify cold start, Record start, and Pi prompt timings.
- **Recording:** Clicking Record no longer reloads the start URL when the embedded browser is already on it (hash differences ignored); the recording baseline is the current page, so use the browser toolbar reload first if a freshly loaded page is required.
- **UI:** Rebranded to the FlowLink green identity end to end: theme colors, header wordmark, navigation labels, and app title replace the previous blue/Taskflow look.
- **Packaging:** The window, taskbar, and packaged `FlowLink.exe` now show the FlowLink icon (multi-size `.ico` under `resources/`, verified by `package.mjs`); the renderer also ships an SVG favicon and logo under `renderer/assets/`.
- **UI:** Static page and panel structure (flow list rows, version rows, recording rows, analysis tabs, AI pane blocks) now lives in `renderer/index.html` templates that JavaScript fills, instead of being assembled from JS strings.
- **Recording:** Auth-shaped redirects (`sso_redirect`/`login_redirect`/`auto_redirect`) are retained in the raw evidence stream and the FlowForge sidecar with their navigation type; they never fold into the previous action's expectation and are kept out of the coalescer, so recorded click expectations are unchanged.
- **Flow:** Migrate existing schema v1 recordings to schema v2 for condition branches without changing their ordered replay behavior.
- **Storage:** Delete a recording's Flow and artifacts with the recording, remove all recordings' files when deleting a taskflow, and discard generated files when closing a new unsaved taskflow.

### Fixed

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
