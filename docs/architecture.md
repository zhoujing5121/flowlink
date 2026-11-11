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

The renderer window is shown after its local HTML loads; the initial browser URL loads asynchronously so restricted or slow external networks do not delay application startup. Task-list metadata is loaded at startup, while recording flows and their step/reference details are hydrated only when that task's detail drawer opens. Pi's SDK is loaded on demand in a Node worker thread, keeping SDK initialization and provider requests off Electron's main thread.

The embedded browser is a `WebContentsView`, not an iframe. `renderer/bridge.js` reports the DOM rectangle occupied by the browser surface; the main process moves and shows the native view at that rectangle. Native visibility has one explicit owner independent of `webContents.isLoading()`, so navigation and load completion do not blank the view or reveal it over dialogs. Workspace confirmations temporarily hide the native view, then restore the reported bounds.

## Preload boundary

`src/preload.ts` exposes a narrow `window.flowlink` API. It groups operations into:

- `tasks`
- `recording`
- `playback`
- `flow`
- `browser`

The renderer may subscribe only to explicitly allow-listed event channels.

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

Writes are persisted atomically where implemented. The store falls back to an empty task list if the JSON file is missing or invalid. On startup, the renderer loads task profiles and recording counts only; opening a task drawer loads its recording metadata and saved Flow details. Transient UI state such as open tabs, focus, and panel sizes is intentionally not restored.

## Flow IR

`engine/schema/src/schema.ts` defines versioned action IR with Zod. `engine/schema/src/io.ts` handles migration, parsing, validation, serialization, and atomic flow writes.

Important invariants:

- `observed` facts are immutable record-time evidence.
- `candidates` and resolved data may be updated for self-healing.
- Password input values must use named templates such as `{{password}}`.
- Candidate arrays are sorted by ascending score.
- Relative crop paths are validated and must not escape the artifact root.
- Schema migration belongs in `migrateFlow()` rather than ad hoc load logic.

Core step kinds include navigation, click, input, select, key, hover, scroll, drag, upload, wait, assertion, extraction, script, dialog, tab switch, and nested groups.

## Recording pipeline

1. The capture script is installed into the page.
2. DOM events and navigation events enter a raw-event buffer.
3. Events are coalesced into high-level actions after the configured silence interval.
4. Stable element facts are recollected by UID.
5. Candidates and fingerprints are derived and validated.
6. The element and nearby frame path are stored in `ElementRef`.
7. Page signatures infer an expectation for the action.
8. Native Electron tabs attached after recording starts produce an `openTab` step; the first same-tab navigation is merged into that step's `url` for replay.
9. Stopping the recorder flushes pending actions and writes a validated flow. Stop also aborts in-flight startup navigation/CDP attachment rather than waiting for startup to finish. An empty Stop exits the renderer immediately and performs discard cleanup in the background. If no steps were captured, the recorder raises `EmptyRecordingError`; the main process treats this as clean cancellation and does not persist a recording.

`EngineBridge` uses window markers to map Electron `WebContentsView` instances to Playwright `Page` objects. URL matching alone is not sufficient because multiple tabs may share an origin. Pages supplied at recording startup are treated as existing context rather than newly opened tabs.

## Replay pipeline

The executor loads or receives a validated `Flow`, resolves elements, executes one step at a time, records screenshots and logs, and writes a run report.

Element resolution uses ordered candidates, role/text/locator validation, frame paths, fingerprints, and resolver logic. Replay stops after the first failure when `stopOnFailure` is enabled.

Non-secret Reference variables are saved as validated `flow.variables` defaults. Secret values are kept in renderer memory and passed only to that replay run, not stored in the Flow. Replay uses the executor's normal template-variable resolution; uploaded files remain Reference items and are not injected as runtime variables.

Self-healing records are kept separate from observed facts. Healing is written back only when `writeBack=true` and a flow path is supplied; successful writes create a `.bak` copy and increment the flow version.

## Group re-recording

Re-record and Add-before replay the flattened steps before the selected process group; Add-after replays through the end of that group. `playback:runPrefix` constructs and validates an in-memory prefix flow without changing the original flow or run metadata.

After a successful prefix run, `recording:start` uses `preservePage=true`, so it attaches to the resulting document without reloading it. Electron playback supplies a native `openPage` factory to the executor, avoiding unsupported CDP `Target.createTarget` calls. `EngineBridge` maps pages back to native tab IDs, and the executor reports the final active page index for the next recording session. Prefix failures return to the existing Process view without starting a new recording.

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
