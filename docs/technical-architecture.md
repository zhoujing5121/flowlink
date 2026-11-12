# FlowLink Technical Architecture

This guide describes how the current Windows desktop application is assembled,
how a recorded flow moves through the system, and which boundaries are intended
to remain stable when changing it. The shorter [Architecture](./architecture.md)
page is the runtime overview; this document adds implementation and lifecycle
detail.

## 1. Product and runtime model

FlowLink is an Electron desktop application that records browser interactions as
validated Flow JSON and replays those flows against an embedded Chromium browser.
The desktop shell owns browser tabs, persistence, and IPC. Engine packages own
the Flow contract and the recording, element-resolution, and execution logic.
The renderer is a UI client: it does not directly import Node.js or Electron APIs.

```text
renderer/index.html + app.js + bridge.js
            │ window.flowlink (preload)
            ▼
      IPC invoke/events
            │
            ▼
 src/main.ts ─── TaskStore (tasks.json)
      │
      ├── WebContentsView tabs ─── embedded Chromium
      │              │
      │              └── CDP ── EngineBridge ── Playwright Page
      │                                      │
      ├── recorder ── capture client/script  │
      ├── schema ─── validated Flow IR       │
      ├── resolver ── element matching       │
      ├── executor ── actions/report/artifacts
      │
      └── pi-agent worker ── Pi SDK sessions (on demand)
```

### Runtime ownership

| Area | Owns | Does not own |
|---|---|---|
| Renderer | UI state, forms, design/review views, browser surface geometry | Filesystem access, Electron objects, direct engine calls |
| Preload | The explicit `window.flowlink` capability API and event allow-list | Business logic or arbitrary IPC forwarding |
| Main process | BrowserWindow/WebContentsView lifecycle, IPC handlers, session orchestration, persisted task metadata | Flow action semantics and element-matching algorithms |
| Schema | Flow format, parsing, migration, contract validation, file IO | Recording-time DOM collection or replay page control |
| Recorder | Browser event capture, event coalescing, observed facts, action planning | Electron window ownership or durable task-profile storage |
| Resolver | Candidate ranking and element/frame matching | Mutating the immutable observed record-time evidence |
| Executor | Step sequencing, actions, verification, self-healing decisions, run artifacts | Renderer state or direct UI manipulation |
| Pi agent worker | On-demand LLM sessions that return advice/proposal text | Filesystem writes, tool execution, or durable task/flow state |

## 2. Source map

| Source | Responsibility |
|---|---|
| `src/main.ts` | Electron startup, native browser tabs, IPC, record/replay session lifecycle |
| `src/preload.ts` | Typed-facing renderer bridge over `contextBridge` and `ipcRenderer` |
| `src/store.ts` | Task profile and recording metadata persistence |
| `src/engine-bridge.ts` | CDP connection and mapping native WebContents tabs to Playwright Pages |
| `src/pi-agent.ts` | Pi worker lifecycle, settings/credential validation, `pi:*` IPC handlers |
| `src/pi-agent-worker.ts` | Node worker thread hosting Pi SDK sessions with a restricted resource loader |
| `renderer/index.html` | Static UI shells and `<template>` elements for repeated rows and per-flow recording workspaces; JavaScript fills these instead of authoring markup |
| `renderer/app.js` | UI state, profile/recording workflows, Process editor, AI advice pane, and template slot filling |
| `renderer/bridge.js` | Connects the UI to preload IPC; loads persistent tasks and forwards live events |
| `engine/schema/src/` | Flow types, Zod schemas, migration, validation, serialization |
| `engine/recorder/src/` | Recording lifecycle, element facts, event coalescing, planning and expectations |
| `engine/recorder/src/classify.ts` | Auth-URL classification on built-in patterns and the auto-navigation type set that becomes optional steps |
| `engine/recorder/src/systems.ts` | URL-to-system identity resolution with optional hostname aliases |
| `engine/recorder/src/flowforge-capture-schema.ts` | Zod contract for the FlowForge-compatible capture archive (`flowforge.recording.v1`) |
| `engine/recorder/src/flowforge-archive.ts` | Converts raw capture plus Electron host events into the validated recording sidecar |
| `engine/recorder/capture/capture.js` | Page-side event collector installed into captured pages |
| `engine/resolver/src/` | Candidate generation, fingerprints, scoring and frame-aware resolution |
| `engine/resolver/src/url.ts` | URL re-basing (`baseUrl` origin replacement) shared by navigate steps and iframe `urlPattern` matching |
| `engine/executor/src/` | Replay runner, actions, tabs, dialogs, downloads, verification, healing and artifacts |
| `engine/executor/src/batch.ts` | Batch replay: one browser launch, one isolated context per CSV row (engine capability, not yet exposed in the desktop shell) |
| `tests/flow-authoring.test.mjs` | `node --test` suite bundling engine modules with esbuild; covers schema migration and condition/planning contracts |

`build.mjs` bundles the TypeScript main process as ESM and preload as CJS.
Electron, Playwright Core, Zod, the Pi coding-agent SDK, and undici remain
external runtime dependencies. The capture script is a static engine resource
and is located relative to the built main entry. `package.mjs` validates the
packaged executable, `ffmpeg.dll`, and `resources/icon.ico` before creating
the Windows ZIP.

## 3. Electron security and browser boundary

The renderer window enables `contextIsolation` and disables `nodeIntegration`.
The preload exposes the single `window.flowlink` object. Invoke operations map
to named `ipcMain.handle` handlers; subscriptions are limited to a fixed set of
event channel names and return an unsubscribe callback. Renderer code should
not add `require`, Node imports, Electron imports, or direct filesystem access.

The browser content is a sandboxed `WebContentsView`, not an iframe. This keeps
the browser's navigation and rendering lifecycle under Electron's control while
letting the UI provide surrounding controls. The renderer reports the browser
surface's rectangle; the main process applies that rectangle to native views.
Visibility is explicit state: only the selected view may be shown, and only
when the surface is enabled and has usable bounds. Page loading does not control
visibility, avoiding a blank or unexpectedly exposed native surface during
navigation and dialogs.

Navigation initiated by the address bar is normalized in the main process and
restricted to HTTP/HTTPS. Requests for new windows are converted into native
browser tabs rather than allowing separate unmanaged windows. Playback tab
creation also uses a native view factory; it does not ask CDP to create an
independent target.

### CDP-to-Playwright mapping

Electron is started with `--remote-debugging-port=0`; the selected port is
published asynchronously in `DevToolsActivePort`. Once that file is available,
`EngineBridge` connects to `127.0.0.1` using Playwright's `connectOverCDP`.

The bridge maps each FlowLink tab ID to a Playwright `Page`. It first writes a
tab-specific marker into that tab's `webContents` and searches pages for the
marker. This is stronger than URL matching because independent tabs can share
the same URL. A CDP target-ID comparison is a fallback. Discovery is retried
with a bounded wait because WebContents creation and CDP target publication are
asynchronous. The mapping is cached and explicitly forgotten when tabs close or
the tab set is reset.

## 4. Startup and build

1. Electron becomes ready and establishes the user-data directories for flows
   and artifacts.
2. The `TaskStore` is created for `tasks.json`; IPC handlers are registered.
3. The main window and initial embedded browser view are created.
4. The main process waits for `DevToolsActivePort` and initializes
   `EngineBridge`, then prewarms the CDP attach for the active tab in the
   background. Prewarm failures never block startup; the recording start
   handler keeps its own engine guard. `playwright-core` is loaded by dynamic
   import on first attach, not during startup.
5. The renderer loads task and recording metadata through `window.flowlink`.
6. The Pi agent worker is spawned lazily but prewarmed: roughly 1.5 s after
   the window is shown, or as soon as the AI pane opens (`pi:prewarm`), the
   worker imports the SDK and fills the runtime cache without contacting the
   provider, so the first real prompt only pays session creation and the
   provider round trip. The worker is still terminated after idle use or app
   quit.
7. Starting a recording no longer reloads the start URL when the embedded
   browser is already on it (origin/path/query equal, hash ignored): the
   recording baseline is the current DOM, matching `preservePage` semantics.
   `browser:restart` remains a full reset — it clears the attach cache and
   re-prewarms in the background.

The build command produces `dist/main.js` and `dist/preload.cjs` with source
maps. The ESM main bundle retains native `import.meta.url` behavior; the preload
bundle is CJS for Electron's preload loading. The packager command first builds,
packages the Windows x64 application, then archives the validated package
directory.

## 5. IPC and state ownership

The preload API is grouped into `tasks`, `recording`, `playback`, `pi`, `flow`,
`browser`, and `on` event subscriptions. These groups describe capabilities,
not independent data stores:

- Task and recording metadata are owned by `TaskStore`.
- Flow JSON and run artifacts are owned by schema IO and the recorder/executor
  artifact writers.
- Browser tabs and native visibility are owned by the main process.
- Renderer state is reconstructed from store data and live IPC events.

Notable invoke channels beyond the basic CRUD/navigation set:

- `recording:persistMerged` saves a caller-supplied, already-validated Flow as
  a brand-new recording (`isMerged: true`). It is the persistence path for
  merged and AI-refined materials; it never overwrites an existing recording.
- `flow:updateVariables` and `flow:updateSteps` re-parse and re-save a Flow
  after Reference-variable or Process-editor edits, bumping the flow version
  and keeping a backup.
- `playback:runPrefix` runs only the first N executable steps of a recording
  (see §10), and `playback:continueUserOperation` resumes a paused replay
  after an explicit user confirmation (see §9).
- `pi:status` validates local settings/credential shape only; `pi:prompt`
  dispatches one bounded prompt to the Pi worker (see §11).

The `playback:userOperation` event carries a one-time `token`; the renderer
banner can only resume the wait it was issued, and a stale token is rejected.

Recording and playback are single active operations in the main process.
Promises track active startup, stop, record, and replay operations; abort
controllers interrupt cancellable work. Stop and browser restart share the same
recording cleanup path so concurrent requests do not save or delete the same
output twice. Group re-recording has a separate prefix replay route so it can
prepare the current browser state without changing the saved flow's run metadata.

Events such as recording steps, recording completion, playback step results,
browser URL/loading changes, tab creation, and capture frames flow from main to
renderer. They update presentation state; the durable source of truth remains
the store, Flow file, and artifacts on disk.

## 6. Persistence and data layout

All durable application data lives under Electron's user-data directory:

```text
<userData>/flowlink/
  tasks.json
  flows/
    <flow-id>.json
  artifacts/
    <flow-id>/
      record/
        elements/
        screenshots/
        video/
        flowforge-recording.json
      runs/
        <run-id>/
          result.json
          <step-index>/
            before.png
            after.png
            snapshot.json
            log.txt
          downloads/
      batches/
        <batch-id>/
          row-<index>/
            result.json
            log.txt
```

`tasks.json` stores task profiles and recording metadata, including the
associated Flow path, artifact directory, screenshots, optional video, and
latest run summary. Flow files are independently validated structured records.
Record and replay artifacts are separate so a run does not overwrite the
evidence captured during recording. `flowforge-recording.json` is the
validated FlowForge-compatible capture sidecar written at recording stop; the
executable Flow IR remains the source of truth for replay and the sidecar is
never executed (see `docs/FLOWFORGE_MERGE.md`). Batch row artifacts are
produced only by the engine-level batch runner and are not yet written by the
desktop shell.

Pi configuration lives outside the artifact tree: `<appPath>/config/pi-settings.json`
holds provider/model/thinking/timeout defaults, and credentials live in
`<appPath>/config/pi-auth.json` during development or `<userData>/pi-auth.json`
in packaged builds. The credential file is a secret; it must never be
committed, logged, or packaged.

Task persistence writes a temporary sibling file and renames it into place,
avoiding partial JSON at the destination. On first load, missing or invalid
task JSON is treated as an empty store so startup can proceed; later write
failures are not silently converted into successful persistence. Flow writes
use schema IO and its contract checks. Generated IDs and path segments must be
sanitized, and artifact writers must keep resolved output within their intended
root.

The task store lazily loads once and shares the initial load among concurrent
operations. It returns tasks in code order for stable display. Profiles and
recordings are separate concerns: profile updates retain the existing
recordings array, while recording operations update only recording metadata.

## 7. Flow IR and compatibility contract

`engine/schema/src/schema.ts` is the authoritative Flow/action contract.
Zod parsing is required at file/input boundaries; values should not be treated
as a valid Flow merely because they are typed in TypeScript. `io.ts` handles
loading, migration, validation, serialization, and flow writes. Schema-version
compatibility belongs in the migration path rather than scattered consumers.

Core step families cover navigation, element actions, waits and assertions,
data extraction, scripts, dialogs, tab switching, uploads, and nested groups.
Flattening is used where the UI or prefix replay needs a linear step sequence;
the original grouping remains meaningful in the Flow representation.

Schema v2 adds control flow on top of the v1 ordered sequence:

- A `condition` step carries one assertion (the same assertion union used by
  `assert`) plus optional `trueGroupId`/`falseGroupId`. Each branch target
  must reference an existing non-empty top-level group; contract validation
  rejects dangling references. Omitting a destination ends that branch (the
  replay finishes). The Process editor additionally requires a condition to be
  the final direct step of its group.
- A `wait` step can use `condition: "userOperation"` with a `prompt` string;
  replay then pauses for an explicit host-side user confirmation.
- Recorded text inputs are stored as variable templates (`{{input_N}}`) whose
  non-secret defaults live in `flow.variables` (Reference); password inputs
  remain secret variables without persisted defaults.

`migrateFlow()` upgrades stepwise v0 → v1 → v2 by stamping the new
`schemaVersion` only; it never rewrites existing steps, so v1 recordings
replay identically after migration. Versions above `SCHEMA_VERSION` are
rejected rather than silently downgraded.

Contract invariants:

- `observed` is immutable evidence collected at recording time.
- Candidate lists, fingerprints, resolution results, and healing data are
  mutable resolution metadata and must remain distinct from observed facts.
- Password values are represented by named templates such as
  `{{password}}`; a secret must not be copied into a saved action value.
- Candidate ordering and confidence semantics are defined by the resolver
  contract rather than by renderer presentation.
- Relative artifact references must not escape the artifact root.
- Each top-level group may be entered at most three times per replay run;
  exceeding the limit fails the run with `FLOW_LOOP_LIMIT` so a bad branch
  cannot loop forever.
- New schema versions require explicit migration and backward-compatibility
  consideration.

## 8. Recording data flow

1. The main process chooses or preserves the target native browser page and
   attaches Playwright through `EngineBridge`.
2. The recorder installs `capture.js` into the page. That script listens for
   relevant browser-side events and emits raw event records with element
   identity/context.
3. `capture-client.ts` receives and translates browser events into recorder
   inputs. Raw events remain buffered briefly so event sequences can be
   interpreted together rather than saved as unrelated low-level events.
4. The coalescer groups event bursts into meaningful actions after the
   configured quiet interval. It handles cases such as typing followed by
   change/blur and drag sequences that should yield one user intent: a trusted
   `dragStart`+`drop` pair on one tab within `DRAG_PAIR_MS` (5 s) coalesces
   into a `drag` action carrying source and target facts, and its step planner
   resolves both into `ElementRef`s (skipping the step with a warning when
   either side cannot be re-verified); unpaired, cross-tab, stale, or
   interrupted drags remain evidence-only, and v1 does not infer expectations
   for drag steps.
5. Element collection re-reads stable facts by capture UID, derives candidate
   locators and fingerprint information, and records frame context. Facts that
   cannot safely be recovered are not silently fabricated from a later page
   state.
6. Planning and expectation inference produce action steps and expected
   outcomes. The schema validates the assembled Flow before it is written.
7. Step callbacks stream progress to the UI. Stop flushes pending coalesced
   actions before final persistence; a truly empty recording is a cancellation
   outcome and does not create a saved recording.

Alongside page-side events, the main process feeds a mutable host-event buffer
into the recorder while a session is active. Address-bar navigation
(`userNavigateRequested`), Back/Forward/Reload requests, native tab creation,
activation, closure, and observed redirects (`autoRedirect`) are recorded with
native tab IDs. The planner merges this timeline with page events by timestamp
to emit `openTab`/`switchTab` steps and to classify navigation causes:
explicit address-bar requests become `user_navigate` steps, link clicks whose
`href` matches become `user_link`, and auth-shaped transitions are classified
as `sso_redirect`/`login_redirect`. Classification runs on built-in IdP
host/login-path patterns compiled into the code — no configuration file is
read; the same matchers are reused by the sidecar writer's host-redirect
re-classification so the Flow and the archive never disagree. Auth redirects
stay in the raw evidence stream and are kept out of the coalescer (they would
otherwise fold into the previous action's `expectUrl`); instead each is
synthesized as a standalone `navigate` step flagged `isOptional`, which replay
resolves at runtime (see §9).
Navigation without an observable cause is retained as `unknown_navigation`
with its evidence rather than guessed.

At stop, the recorder also writes the FlowForge sidecar
(`flowforge-recording.json`): the globally ordered raw event stream with
stable event IDs, tab/system identity, before/after DOM signatures, locator
evidence, and `flowStepId` links back to executable steps. System identity is
resolved from URLs by the shared resolver; the optional alias map (a
programmatic engine API, not a user config file) can collapse multiple
hostnames into one logical system and merge their domains into a single
`systems[]` entry. Step provenance
fields (`tabId`, `systemId`, `pageUrl`, `sourceEventIds`) are part of the
Flow schema. See `docs/FLOWFORGE_MERGE.md` for the archive contract and
privacy rules (input values and clipboard text are never written to the
sidecar).

The first same-tab navigation for a newly opened native tab is merged into that
tab's open action so replay can reproduce the tab and destination together.
Pages that existed before recording are seed context, not implicitly new tabs.
Stopping while startup is waiting for navigation or CDP attachment aborts that
startup; transient capture output is discarded on cancellation.

## 9. Replay, resolution, and verification

The executor accepts a validated Flow and a seed Playwright page (plus optional
additional pages). It runs steps serially, reports step status, captures
before/after evidence and logs, and writes a run result. Cancellation is driven
by an abort signal. When configured to stop on failure, execution ends at the
first failing step and preserves its report/artifacts for diagnosis.

Steps flagged `isOptional` (machine-initiated auth redirects recorded as
`navigate` steps) are resolved at runtime: the executor waits
`OPTIONAL_NAV_WAIT_MS` (800 ms) and compares the current URL's origin+pathname
against the step's recorded `previousUrl` (`sameSitePath`; query strings and
hashes are ignored because SSO round-trips carry per-run state parameters).
If the browser has already moved on, the redirect happened by itself and the
step is reported as `skip` (not a failure); otherwise the navigation executes,
covering the case where record-time and replay-time auth state differ.

Control flow runs on the flattened step cursor. Each flat step records the
top-level group that owns it; a `condition` step evaluates its assertion as a
boolean (`evaluateAssertion` treats `EXPECT_MISMATCH` as "false" and rethrows
everything else) and jumps the cursor to the start of the matched group, or to
the end of the run when no destination is given. Group entries are counted at
each group's first flat index; the fourth entry of the same group fails with
`FLOW_LOOP_LIMIT`, which stops the run even when `stopOnFailure` is off.
A `wait` with `condition: "userOperation"` pauses execution through a
host-provided `waitForUserOperation` callback — in the desktop shell this
sends a `playback:userOperation` event with a one-time token and resumes via
`playback:continueUserOperation`; aborting the replay rejects the wait.

For element actions, the executor asks the resolver to select a usable target.
Resolution uses the recorded candidate order and validates candidate matches
against role/text/locator context, frame paths, and element fingerprints. The
resolver owns scoring and ambiguity handling; action code should not invent
ad-hoc locators that bypass it. If matching fails, the error/result path retains
diagnostic evidence instead of reporting a successful fallback.

The action layer executes navigation, clicks, input, selection, key, hover,
scroll, drag, upload and other supported step families. Verification checks
expected page state after an action. Dialog/download/tab helpers isolate browser
events that require explicit lifecycle handling. Self-healing may update
resolution data, but observed recording-time evidence remains unchanged.
Flow write-back is opt-in and requires a flow path; successful write-back keeps
a backup and advances the flow version.

## 10. Re-recording and prefix replay

Node re-recording first builds an in-memory Flow containing the required
prefix with `prefixSteps()`, which keeps the original group/control-flow
structure instead of slicing the flattened list, and drops condition branch
targets that fall outside the prefix. That temporary Flow is schema
parsed before execution. Prefix replay is deliberately excluded from normal
last-run status updates. On success, the browser remains at the reached state
and recording starts with `preservePage`, avoiding a reload that would discard
the state just prepared by replay.

Add-before and re-record replay the steps preceding the selected group; add-after
replays through the end of that group. Playback-created pages are mapped back
to native tab IDs so a subsequent recording can continue in the correct tab.
Every Test entry serializes stop/reset work before replacing views, preventing a
stale recording from continuing against a fresh browser session.

## 11. AI assistance (Pi coding agent)

FlowLink embeds the `@earendil-works/pi-coding-agent` SDK — it does not spawn
the `pi` CLI. `src/pi-agent.ts` owns the worker lifecycle: it validates
settings and credential shape before every request, enforces a prompt-size
limit (100,000 characters) and a request timeout clamped to [5 s, 600 s], and
correlates renderer requests to worker responses by id. The worker
(`src/pi-agent-worker.ts`) is spawned lazily on the first prompt, is
`unref`'d while idle, is terminated on timeout, and is disposed at app quit.

Inside the worker, an Undici `EnvHttpProxyAgent` is installed as the global
dispatcher before the SDK is imported, so provider requests honor
`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (browser traffic is configured
separately). The SDK session is created per prompt with an in-memory session
manager and a restricted `DefaultResourceLoader`: extensions, skills, prompt
templates, themes, and context files are disabled, the FlowLink system prompt
is forced, and `noTools: "all"` leaves the model text-only. Recording data and
page text are treated as untrusted evidence, never as instructions. A model
runtime is cached per (auth path, provider, model) and re-created on failure.

Renderer integration is advice-first. Four intervention points exist:

1. After a recording stops, the AI pane opens automatically and asks for
   evidence-grounded replay-reliability advice.
2. Selecting one or more analyzed materials and choosing Refine opens an
   options form (preset refinements plus free text); Continue dispatches one
   generation request. Nothing is saved unless generation succeeds and the
   user-driven persistence path runs.
3. After a failed replay, failed steps and whole-run metrics are passed to Pi
   for diagnosis.
4. When the user explicitly asks to generate/apply a refinement (typed request,
   `@`-attached flows, or the Refine options form), FlowLink re-parses the
   proposed steps through the schema and, if valid, saves them via
   `recording:persistMerged` as a new recording (`isMerged: true`). The source
   recording is never overwritten, and invalid output is rejected at the
   persistence gate.

### Generation pipeline (`src/ai-refine.ts`, IPC `pi:generateFlow`)

Material generation runs entirely in the main process. The renderer sends only
recording ids, an optional instruction, and plain-text conversation; `ai-refine.ts`
loads the source flows and drives four stages:

1. **Projection** — every `target`/`from`/`to`/`expect.target` ElementRef in the
   source steps is replaced by `{"$ref": "eN"}` against a deduplicated element
   library (keyed by `fingerprint.stableHash` + first candidate). The prompt
   carries each library element once as a one-line summary plus compact step
   JSON; budget caps (library 10k, steps 60k, conversation 12k, instruction 4k
   characters) fail loudly instead of truncating.
2. **Prompt** — one of two fixed templates: auto-sanitize (recording stop) or
   refine-with-instruction; the worker system prompt additionally forbids
   inlined element data and `flow.variables` output.
3. **Rehydration** — the model's steps may only reference elements as
   `{"$ref": "eN"}`; unknown ids and any inline element object are rejected
   with the offending step named. Library entries are deep-cloned back in, so
   `observed` evidence returns byte-identical. Missing step ids are generated;
   colliding ids are suffixed `-2`, `-3`.
4. **Validation** — the rehydrated steps go through `parseFlow` (schema v2
   contract included); variables are merged from all sources with the first
   non-secret default winning. The validated flow is returned as a proposal —
   never saved here.

Chat hygiene is enforced in the renderer: `item.chat` entries hold text plus
`{id, name}` attachment chips only, and a 300-step attached flow costs nothing
in UI state because flow payloads are assembled in the main process from the
store.

### Auto-refine (`ai:autoRefine`)

When a recording persists after Stop, the main process (guarded by an
in-flight set, `autoRefine` setting default-on, source `isMerged` excluded)
runs the same pipeline in auto-sanitize mode and saves the result through the
shared merge-persistence helper as `REFINED…` (name collisions get ` (2)`,
` (3)`). Events: `{state:'done', taskCode, sourceRecordingId,
refinedRecordingId, name}` refresh the recording list and toast;
`{state:'failed', error}` shows a dismissible warning; `{state:'skipped'}`
(Pi not configured) is silent. The raw recording is always left intact. The
Pi worker processes prompts sequentially, so an in-flight advice call simply
delays the twin by its remaining duration.

The AI pane conversation history (recent turns) is included as bounded context
in follow-up prompts. AI-generated materials are not considered verified until
a real replay passes.

## 12. Batch replay (engine capability)

`engine/executor/src/batch.ts` (`playBatch`, `runBatchRows`,
`summarizeBatch`, `pickFailedStep`) replays one Flow across many
variable rows: the browser launches once, each row gets a fresh context with
the shared storage state, row artifacts land under
`artifacts/<flowId>/batches/<batchId>/row-<index>/`, a `VARIABLE_MISSING`
render error fails only that row, and abort takes effect between rows. The
loop control and aggregation are pure functions for testability. The module
references a `docs/batch-run.md` contract that does not exist in this
repository (it was ported with the module); the desktop shell does not call
it yet — exposing CSV import and a batch-run view is future work.

## 13. Authentication, artifacts, and sensitive data

Playwright storage state may be supplied as raw or wrapped profile JSON.
Missing or malformed state is treated as no profile where the calling workflow
allows it. Storage-state files can contain cookies and local-storage credentials
and must be treated as secrets. The same applies to `pi-auth.json` (provider
API keys) and to authenticated proxy URLs configured through environment
variables.

Do not log cookie values, passwords, storage state, or complete sensitive Flow
variables. Use template references for passwords. Use `ArtifactWriter` and the
existing schema/path helpers instead of writing replay artifacts with arbitrary
paths. Validate/sanitize flow IDs, run IDs, filenames, and any generated
directory segments. Downloads and crops must remain beneath their intended
artifact/output roots.

## 14. Change and validation guidance

When modifying behavior, follow the ownership boundary above:

- Change Flow fields and compatibility in the schema and IO layer first.
- Keep browser-side event facts in the capture script/client and interpretation
  in recorder planning/coalescing modules.
- Keep element matching in the resolver; executor actions should consume its
  resolution APIs.
- Add renderer-to-main operations through both `src/main.ts` and `src/preload.ts`;
  never expose unrestricted IPC.
- Keep native tab visibility, bounds, and tab-to-Page mappings synchronized in
  the main process and UI bridge.
- Persist run outputs through the artifact writer and validate Flow writes.
- Update this guide and the concise architecture page when public behavior or
  subsystem boundaries change.

The repository's baseline checks are:

```powershell
npm run build
npx tsc --noEmit
npm test
```

`npm test` runs `node --test`; `tests/flow-authoring.test.mjs` bundles the
schema IO, recorder planning, and executor step modules with esbuild into a
temporary directory and asserts the migration, condition-branch, and prefix
contracts without launching Electron.

For an Electron integration change, also exercise the relevant user path:
record one navigation/click/input sequence and stop; replay a successful Flow
and inspect a failure report; or test the affected IPC/UI workflow. Packaging
checks are needed when the packaging script or packaged resources change.
