# FlowLink Architecture

For a deeper component, data-flow, lifecycle, build, and security-boundary reference, see
[Technical Architecture](./technical-architecture.md).

## Runtime layers

```text
Renderer UI (renderer/index.html + bridge.js)
  -> window.flowlink via contextBridge
  -> IPC
Electron main process (src/main.ts)
  -> TaskStore
  -> EngineBridge / CDP / Playwright
  -> recorder / executor / schema / resolver engines
Embedded WebContentsView
```

## Main process

`src/main.ts` creates the Electron window, embedded browser view, task store, IPC handlers, and recorder/playback sessions. It enables Electron CDP on a random port and waits for `DevToolsActivePort` before constructing `EngineBridge`.

The renderer window is shown after its local HTML loads; the initial browser URL loads asynchronously so restricted or slow external networks do not delay application startup. Task-list metadata is loaded at startup, while recording flows and their step/reference details are hydrated only when that task's detail drawer opens. Pi's SDK is loaded on demand in a Node worker thread, keeping SDK initialization and provider requests off Electron's main thread. All Pi prompts (session system prompt, auto/refine generation, AI-pane advice) are maintained as `{{placeholder}}` templates in `config/prompts.json`; the main process loads and validates the file, injects the system prompt into worker sessions, and hands the advice templates to the renderer through the `pi:promptTemplates` IPC. After a failed Test run, the user can start the "AI Continue" assisted loop from the AI pane: program replay is re-run, and at each failed step an AI takeover session (`src/ai-takeover.ts`) lets a `@browser_use/pi` agent attach to the same Chromium over CDP and complete only that step under domain/secret/budget guardrails before program replay resumes from the next step (at most 6 single-step interventions per test run; the loop stops when the same step defeats the agent twice — there is no full-takeover entry or free-run fallback). Progress is reported via `playback:aiStep`/`playback:aiDone` events, and the takeover itself never modifies the source Flow. Pi requests use environment proxy variables by default; `--pi-system-proxy` resolves the Windows proxy/PAC for the model endpoint, and `--pi-proxy=<URL>` selects an explicit HTTP, HTTPS, or SOCKS5 proxy.

The embedded browser is a `WebContentsView`, not an iframe. `renderer/bridge.js` reports the DOM rectangle occupied by the browser surface; the main process moves and shows the native view at that rectangle. Native visibility has one explicit owner independent of `webContents.isLoading()`, so navigation and load completion do not blank the view or reveal it over dialogs. Workspace confirmations temporarily hide the native view, then restore the reported bounds.

## Preload boundary

`src/preload.ts` exposes a narrow `window.flowlink` API. It groups operations into:

- `tasks`
- `processLandscape`
- `recording`
- `playback`
- `flow`
- `browser`

The renderer may subscribe only to explicitly allow-listed event channels.
The four required Service Level fields load their cascading options from
`process_landscape/full.json` through a dedicated preload API; the renderer never
reads the file directly.

## Persistence

`TaskStore` persists task profiles and recording metadata in:

```text
<userData>/flowlink/tasks.json
```

Flow JSON files and recorder artifacts are written below:

```text
<userData>/flowlink/flows/
<userData>/flowlink/artifacts/
```

Writes are persisted atomically where implemented. The store falls back to an empty task list if the JSON file is missing or invalid. On startup, the renderer loads task profiles and recording counts only; opening a task drawer loads its recording metadata and saved Flow details. Deleting a recording removes its Flow JSON, Flow artifacts, and capture-frame directory; deleting a task removes all of those files for its recordings. Closing a new, unsaved taskflow discards recordings created under that draft. Transient UI state such as open tabs, focus, and panel sizes is intentionally not restored.

## Flow IR

`engine/schema/src/schema.ts` defines versioned action IR with Zod. `engine/schema/src/io.ts` handles migration, parsing, validation, serialization, and atomic flow writes.

Important invariants:

- `observed` facts are immutable record-time evidence.
- `candidates` and resolved data may be updated for self-healing.
- Password input values must use named templates such as `{{password}}`.
- Candidate arrays are sorted by ascending score.
- Relative crop paths are validated and must not escape the artifact root.
- Schema migration belongs in `migrateFlow()` rather than ad hoc load logic.

Core step kinds include navigation, click, input, select, key, hover, scroll, drag, upload, wait, assertion, condition, extraction, script, dialog, tab open/switch/close, and groups. Schema v2 adds condition branches; v0/v1 flows migrate on load while preserving their existing steps.

Two optional provenance fields record where AI-refined material came from (schema v2, no version bump; both must stay declared in the schema because Zod strips unknown keys on every save/load):

- `meta.sourceFlows[]` — the *direct* sources of an AI-merged flow (`recordingId`/`flowId`/`title`/`flowFile`). Re-refining a REFINED flow records only the new direct sources; the transitive chain is recoverable by following each source flow's own `meta.sourceFlows` by `flowId`. Purely recorded flows leave the field unset.
- `step.sourceFlowId` — per-step source flow, inferred at rehydration time from the element library origins (the flowId that the step's `$ref`s most often reference; steps without element references inherit the previous annotated step, and the first step inherits forward). This is a heuristic annotation used by the Process graph to segment and color independent sub-flows; it never affects execution.

A step may also carry an optional `settle` object (`networkIdle`, `domQuietMs`, `maxMs`) that asks the executor to let the page settle *before* the step runs; see the replay pipeline below.

## Recording pipeline

1. The capture script is installed into the page.
2. DOM events and navigation events enter a raw-event buffer.
3. Events are coalesced into high-level actions after the configured silence interval. A trusted `dragStart`/`drop` pair on the same tab within the pairing window becomes one `drag` step; unpaired, interrupted, or cross-tab drags stay evidence-only.
4. Stable element facts are recollected by UID.
5. Candidates and fingerprints are derived and validated. Candidate validation uses a "unique among visible elements" rule: when a candidate matches several nodes, hidden copies (templates, stacked notifications) do not count against uniqueness, so semantic candidates such as `text:"关闭"` survive alongside hidden duplicates instead of being discarded in favor of a structurally unique xpath. When `ariaSnapshot` cannot supply a role/accessible name, the recorder backfills an approximation (tag → implicit role, own text → name) so role+name candidates and a meaningful fingerprint still exist. Fingerprint attributes exclude framework-internal markers (`data-bind`, `data-reactid`, `data-v-*`, `ng-*`) and values containing line breaks. A step whose surviving candidates are all structural (no testid/role/label/text, only css-path/xpath level selectors) is written with `reviewRequired`/`reviewReason` so fragile steps are flagged at record time.
6. The element and nearby frame path are stored in `ElementRef`.
7. Page signatures infer an expectation for the action.
8. Native Electron tabs created during recording produce `openTab` steps, and explicit activation or subsequent page activity records `switchTab`; the first navigation in a new tab is merged into its `openTab` URL.
9. Browser address-bar navigation is recorded as a user navigation. Auth-shaped redirects are classified with built-in IdP host/login-path patterns (no configuration file). Each becomes a `navigate` step flagged `isOptional`, retained in the raw evidence stream and the FlowForge sidecar; replay waits briefly and skips the step when the browser has already redirected on its own.
10. Text input actions use variable templates; non-secret defaults appear in Reference, and password values remain secret variables without persisted defaults. Single-select dropdowns are parameterized the same way (`select_N` with the recorded value as default); multi-select keeps inline values. Stopping the recorder flushes pending actions and writes a validated flow. Stop also aborts in-flight startup navigation/CDP attachment rather than waiting for startup to finish. An empty Stop exits the renderer immediately and performs discard cleanup in the background. If no steps were captured, the recorder raises `EmptyRecordingError`; the main process treats this as clean cancellation and does not persist a recording.
11. After the recording metadata is durable, the main process fire-and-forget auto-refines it through the shared AI pipeline and saves a `REFINED…` twin via the merge path (never overwriting the source); `ai:autoRefine` events report done/failed/skipped, and `autoRefine: false` in `config/pi-settings.json` disables the twin generation. Manual refinements from the AI pane (`pi:generateFlow`) additionally record where the material came from: the loaded sources become `meta.sourceFlows`, and each generated step is annotated with `sourceFlowId` inferred from its element-library origins (single-source auto-sanitize writes neither field; see Flow IR).

`EngineBridge` uses window markers to map Electron `WebContentsView` instances to Playwright `Page` objects. URL matching alone is not sufficient because multiple tabs may share an origin. Pages supplied at recording startup are treated as existing context rather than newly opened tabs.

System identity (`systemId`/`systemName` on steps, raw events, tabs, and the sidecar `systems[]` list) is resolved from the page URL by one shared resolver. A programmatic alias option (exact case-insensitive hostname match) can collapse several hostnames of one logical system into a single identity and merge their domains; the desktop app does not configure aliases, so hosts keep their bare-hostname identity.

## Replay pipeline

The executor loads or receives a validated `Flow`, resolves elements, executes one step at a time, records screenshots and logs, and writes a run report. AI-refined (`isMerged`) recordings replay like any recorded flow: generated steps carry the original recorded element evidence because refinement can only re-reference captured `ElementRef`s through the `$ref` rehydration protocol (see `docs/technical-architecture.md` §11).

Element resolution uses ordered candidates, role/text/locator validation, frame paths, fingerprints, and resolver logic, with one shared visibility semantic on both record and replay sides: L1 semantic candidates and L2 fingerprint pools first drop invisible copies (template/stacked-notification duplicates whose degenerate rectangles would otherwise force an ambiguous refusal); "several matches but exactly one visible" resolves to that visible element, while several visible matches still require the geometric separation threshold. L2 attribute-equality reads the element's raw attributes for the keys the flow's fingerprint supplies, so fingerprints recorded under the older, looser attribute policy keep matching. L4 (AI repair) remains an executor-side hook that the desktop app does not inject: a failed step still ends the run, and the user can start the "AI Continue" assisted loop from the AI pane, which hands only the failed step to the AI takeover and then resumes program replay from the next step. Condition steps evaluate the existing assertion types and route to an optional top-level group; omitting a destination ends that branch, and steps skipped by the branch jump are reported as `skip` results so run reports and the Test view stay aligned with the flow's step list. Waiting `expect`/`assert` checks poll for 5s by default (each in-poll element resolve is capped at 1s so the budget holds); a step's `timeout` field overrides that wait (clamped to 1–30s), while `condition` steps stay instantaneous. Each group may be entered at most three times in a run, after which replay fails with `FLOW_LOOP_LIMIT`. A `wait` with `condition=userOperation` pauses for explicit user confirmation from the renderer. Replay stops after the first failure when `stopOnFailure` is enabled.

`isOptional` steps adapt to replay-time state and report `skip` instead of failing: optional `navigate` steps are skipped when the browser has already redirected on its own, and optional element steps (`input`/`select`/`click`/`hover`/`upload`) are skipped when their target does not appear within a short wait. AI-refined login segments rely on this: a gate condition on a target-page element routes an already-logged-in run straight to the business group, while a tolerant sign-in group (optional credential steps closed by an assert on the same element) covers full login and remembered-SSO sessions.

**Settle contract** (`engine/executor/src/settle.ts`): a step with `settle` waits for the page to become stable *before* resolving elements or executing the action — use it on the first action after a slow transition (post-login first screen, a large refresh after submit, a cross-system redirect). `networkIdle: true` waits for Playwright's `networkidle` load state; `domQuietMs` injects a MutationObserver (its own `__rrSettle*` globals, independent of the NO_EFFECT probe, filtering `data-rr-` markers the same way) and polls until the DOM has been quiet for that long. Both share one `maxMs` budget (default 10s). The semantics are best-effort: hitting the budget only logs and continues — settle never fails a step; correctness is left to the subsequent element waits and expect/assert checks, and long-polling sites are tolerated. `navigate` steps (which already wait for load + best-effort networkIdle) and `wait` steps (which are themselves waits) skip settle entirely. Absent the field, replay behavior is byte-for-byte the old one.

Reference is a formalized first-class object model (see "Reference objects" below). Non-secret defaults are saved as validated `flow.variables`; secret values are kept in renderer memory and passed only to that replay run, not stored in the Flow. Uploaded files persist inside the recording artifact tree and survive restarts.

Self-healing records are kept separate from observed facts. Healing is written back only when `writeBack=true` and a flow path is supplied; successful writes create a `.bak` copy and increment the flow version.

## Reference objects

Reference objects live in the pure-function package `engine/reference/` (type catalog, label heuristics, gate evaluator, file-path planning, migration converter). Nothing there depends on other engine packages; `engine/schema`, `engine/recorder`, the replay gate in `src/main.ts`, and the preload IPC surface all consume that single implementation. The renderer reaches it only through `window.flowlink.reference.*` (catalog, label-dedup validation, full validation, file add/remove/read bytes) — the display mapping is never duplicated in the renderer.

Each object carries a raw type from the closed catalog (`url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`) with a unique end-user display name (网址、文本、整数、小数、日期、密钥、Excel、Word、CSV、Markdown、文件). Machine keys (`url_1`/`input_N`/`select_N`/`file_N`/`password`) and `{{template}}` syntax stay ASCII and unchanged, while the business `label` field is the only user-facing name. The recorder emits labels and locators at its variable-extraction sites (label evidence priority: label text > placeholder > aria-label > name attribute > type-semantic fallback; paired same-page date inputs get -开始/-结束 suffixes; locator takes the「页面 · 控件」form from the step's system/page identity plus control evidence, url variables use「地址栏 · 系统名」, missing evidence stays empty). Schema v4 declares `label`/`required`/`rules`/`locator`/`activities`/`file` on `flow.variables` and `flow.referenceFiles` on the Flow; migrations v2→v3 (legacy type mapping, label backfill) and v3→v4 (structured validation converted to Chinese rule sentences via the describe converter, locator backfill from step evidence) never rewrite steps or template keys.

Rules are free text: the program stores and displays them but never parses or executes them (`rules`; the Validation column shows the text, single-line truncated with a full-text hover). Structured validation (case/format/sign/conditional/formula expressions and the sandboxed expression engine) was removed by `simplify-reference-rules`; the only program-side enforcement left is Mandatory. The schema contract layer rejects duplicate labels and escaping `referenceFiles`/attachment paths on every save.

Replay startup is gated in the main process (`playback:run` and `playback:aiContinue`): `gateReferenceVariables` runs once over all objects and the user value table, collecting every Mandatory miss (object label + reason) before any browser reset; with misses the run is refused with a structured `REFERENCE_VALIDATION:` error that the renderer renders as a complete list on the Reference tab with the offending rows flagged. With no misses, the resolved value table — attachment resolution to absolute artifact paths and empty-string fill for non-required objects lacking value/default (the injected-empty object names are logged) — is handed to the executor, which still defensively rejects templates referencing unknown machine keys. Secret values keep the session-only, never-persisted behavior. Attachments of file-typed objects (`excel`/`word`/`csv`/`md`/`file`) are stored under the recording's `references/` directory and declared on the variable as an optional `file: {name, path}` field (path confined to a single `references/` segment); the gate resolves them to absolute paths inside the artifact root so `upload` steps consume them directly, and missing attachment files are named violations.

Activity links are multi-select L1 group ids persisted per Flow version. An unrefined raw recording has one implied whole-recording activity (named after the recording, rendered as non-clickable text) that all objects belong to by default; Refine outputs map to new groups and old links are not migrated across versions. The Reference table renders each selected activity as its own chip row; clicking a chip switches to the Process tab and selects the corresponding L1 group (reusing the canvas selection highlight). The Reference tab's Add button opens the object editor directly (no intermediate chooser). Auto-generated .xls/.md placeholder exports are gone; Download packs attachments only (variable attachments and standalone file rows, bytes read through the attachment IPC). Value attachments of file-typed objects are saved atomically with the variable metadata in one `flow:updateVariables` call (`src/reference-persistence.ts` writes the bytes under `artifacts/<recordingId>/references/` with sanitized, collision-deduped names, then saves the Flow with version increment and `.bak`, rolls back newly written files on save failure, and cleans up orphaned old files after success — replacement uploads delete the old file, the attachment delete button and row deletion clear attachment metadata and file together). The editor's value field renders an upload control for file-typed objects (pick, overwrite, delete; the table value column shows the attachment file name) and text/password inputs otherwise; its rules section is a single free-text box.

AI refine contributes naming, activity suggestions, and rule suggestions: `variableLabels` (non-empty override, unknown machine keys reject the whole generation), `variableActivities` (suggestions only fill variables without usage evidence, clamped to real L1 group ids), and `variableRules` (natural-language rule suggestions grounded in page evidence, left empty when evidence is insufficient). Mandatory and locator never come from the model. `config/prompts.json` states these contracts in the system prompt and both generation templates (labels follow the source language, prefer verb-object phrases, paired ranges use -开始/-结束 suffixes; rules are natural language and never invented). Replay-time AI interpretation/execution of rules is a future capability.

## Group re-recording

Re-record and Add-before replay the flattened steps before the selected process group; Add-after replays through the end of that group. `playback:runPrefix` constructs and validates an in-memory prefix flow without changing the original flow or run metadata.

After a successful prefix run, `recording:start` uses `preservePage=true`, so it attaches to the resulting document without reloading it. Electron playback supplies a native `openPage` factory to the executor, avoiding unsupported CDP `Target.createTarget` calls. `EngineBridge` maps pages back to native tab IDs, and the executor reports the final active page index for the next recording session. Prefix failures return to the existing Process view without starting a new recording.

The Process editor persists top-level groups and manual steps through the validated Flow IPC path. Manual element actions must reference an `ElementRef` already captured by recording; new condition steps must be the final direct step of a group and can target only existing non-empty groups. Reference variables are synchronized from `flow.variables`; secret values are supplied for a replay session and are never saved as defaults.

## Process flow graph

The Process tab renders the flow as a graph (no serial fallback): group cards are the same DOM as before (branch badges, condition styling, click-to-select, step right-click Modify/Break, and the `getBoundingClientRect`-positioned group action menu all keep working), but they are absolutely positioned onto coordinates produced by dagre, with an SVG edge layer underneath drawing real connections — solid fall-through edges, labeled 是/否 condition edges, and dashed back-edges (targets at or before the source, still bounded by the runtime three-visit loop limit).

The renderer has no bundler, so dagre enters only through a vendored build: `src/renderer-vendor.ts` is bundled by `build.mjs` into `dist/renderer-vendor.js` (IIFE, browser, es2022), loaded in `renderer/index.html` before `app.js`, and exposed as `window.__flowlinkDagre`. If the vendor script is missing, the Process panel shows an explicit error instead of a blank canvas.

`renderer/flow-graph.js` (`window.FlowGraph`) owns the model:

- `flattenFlowSteps(steps)` — the single flattening implementation (step ids carry group prefixes exactly like `engine/executor/src/steps.ts`); `renderer/bridge.js` and `renderer/app.js` both consume it, and it feeds the Test step list, the Process graph, and the `playback:step`/`done`/`aiStep` event alignment (`aiStep` events carry `stepId` now, with `stepIndex` kept as a legacy fallback).
- `buildGraph(flow)` — pure derivation: nodes are top-level groups (plus a pseudo-group for consecutive bare top-level steps), each segment gets Start/End sentinels, and edges follow the execution semantics (a group whose final executable step is a condition has no fall-through edge; missing branch targets point at the segment End). Steps are segmented into consecutive runs by `step.sourceFlowId`; segments without cross-segment condition edges are independent connected components — AI-merged multi-flow results render as parallel chains, each with its own Start/End — and any cross-segment condition edge merges the segments into one layout.
- `layoutGraph(graph, measure)` — one dagre pass per connected component, components packed left to right; card sizes are measured from the rendered DOM before layout, and the world element's explicit width/height drives the existing pan/zoom `fit()`.

During replay the same graph overlays run state from `testResults` (aligned by step id): step-row dots and result chips, group-card outlines (green = all passed, red = any failure, gray = all skipped), walked edges highlighted, and branch edges not taken dimmed; the overlay refreshes live whether the user sits on the Test or the Process tab, and editing is blocked while a replay is running. Groups with more than one distinct `sourceFlowId` are color-coded with a legend built from `meta.sourceFlows`.

Every Test entry performs one serialized recording-stop/reset operation. `browser:restart` awaits any in-flight stop before replacing views, leaving one fresh start-URL tab and preventing an old recording session from continuing into Test.

## Artifact layout

Record-time artifacts:

```text
<artifactsRoot>/<flowId>/record/
  elements/
  screenshots/
  video/
```

Replay-time artifacts:

```text
<artifactsRoot>/<flowId>/runs/<runId>/
  result.json
  <stepIndex>/before.png
  <stepIndex>/after.png
  <stepIndex>/snapshot.json
  <stepIndex>/log.txt
  downloads/
```

All flow and run identifiers should pass through `sanitizeSegment`; replay writers also enforce that resolved files remain inside the run directory.

## Authentication

Playwright storage state can be loaded from raw or wrapped profile JSON. Missing or malformed files degrade to “no profile” rather than blocking record or replay. Profile files can contain credentials and should never be committed.
