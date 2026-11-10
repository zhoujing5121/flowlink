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
      └── executor ── actions/report/artifacts
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

## 2. Source map

| Source | Responsibility |
|---|---|
| `src/main.ts` | Electron startup, native browser tabs, IPC, record/replay session lifecycle |
| `src/preload.ts` | Typed-facing renderer bridge over `contextBridge` and `ipcRenderer` |
| `src/store.ts` | Task profile and recording metadata persistence |
| `src/engine-bridge.ts` | CDP connection and mapping native WebContents tabs to Playwright Pages |
| `renderer/app.js` | UI rendering, local interaction state, profile and recording workflows |
| `renderer/bridge.js` | Connects the UI to preload IPC; loads persistent tasks and forwards live events |
| `engine/schema/src/` | Flow types, Zod schemas, migration, validation, serialization |
| `engine/recorder/src/` | Recording lifecycle, element facts, event coalescing, planning and expectations |
| `engine/recorder/capture/capture.js` | Page-side event collector installed into captured pages |
| `engine/resolver/src/` | Candidate generation, fingerprints, scoring and frame-aware resolution |
| `engine/executor/src/` | Replay runner, actions, tabs, dialogs, downloads, verification, healing and artifacts |

`build.mjs` bundles the TypeScript main process as ESM and preload as CJS.
Electron, Playwright Core, and Zod remain external runtime dependencies. The
capture script is a static engine resource and is located relative to the built
main entry. `package.mjs` validates the packaged executable and `ffmpeg.dll`
before creating the Windows ZIP.

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
   `EngineBridge`.
5. The renderer loads task and recording metadata through `window.flowlink`.

The build command produces `dist/main.js` and `dist/preload.cjs` with source
maps. The ESM main bundle retains native `import.meta.url` behavior; the preload
bundle is CJS for Electron's preload loading. The packager command first builds,
packages the Windows x64 application, then archives the validated package
directory.

## 5. IPC and state ownership

The preload API is grouped into `tasks`, `recording`, `playback`, `flow`,
`browser`, and `on` event subscriptions. These groups describe capabilities,
not independent data stores:

- Task and recording metadata are owned by `TaskStore`.
- Flow JSON and run artifacts are owned by schema IO and the recorder/executor
  artifact writers.
- Browser tabs and native visibility are owned by the main process.
- Renderer state is reconstructed from store data and live IPC events.

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
      runs/
        <run-id>/
          result.json
          <step-index>/
            before.png
            after.png
            snapshot.json
            log.txt
          downloads/
```

`tasks.json` stores task profiles and recording metadata, including the
associated Flow path, artifact directory, screenshots, optional video, and
latest run summary. Flow files are independently validated structured records.
Record and replay artifacts are separate so a run does not overwrite the
evidence captured during recording.

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

Contract invariants:

- `observed` is immutable evidence collected at recording time.
- Candidate lists, fingerprints, resolution results, and healing data are
  mutable resolution metadata and must remain distinct from observed facts.
- Password values are represented by named templates such as
  `{{password}}`; a secret must not be copied into a saved action value.
- Candidate ordering and confidence semantics are defined by the resolver
  contract rather than by renderer presentation.
- Relative artifact references must not escape the artifact root.
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
   change/blur and drag sequences that should yield one user intent.
5. Element collection re-reads stable facts by capture UID, derives candidate
   locators and fingerprint information, and records frame context. Facts that
   cannot safely be recovered are not silently fabricated from a later page
   state.
6. Planning and expectation inference produce action steps and expected
   outcomes. The schema validates the assembled Flow before it is written.
7. Step callbacks stream progress to the UI. Stop flushes pending coalesced
   actions before final persistence; a truly empty recording is a cancellation
   outcome and does not create a saved recording.

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

Node re-recording first flattens the existing process steps and builds an
in-memory Flow containing the required prefix. That temporary Flow is schema
parsed before execution. Prefix replay is deliberately excluded from normal
last-run status updates. On success, the browser remains at the reached state
and recording starts with `preservePage`, avoiding a reload that would discard
the state just prepared by replay.

Add-before and re-record replay the steps preceding the selected group; add-after
replays through the end of that group. Playback-created pages are mapped back
to native tab IDs so a subsequent recording can continue in the correct tab.
Every Test entry serializes stop/reset work before replacing views, preventing a
stale recording from continuing against a fresh browser session.

## 11. Authentication, artifacts, and sensitive data

Playwright storage state may be supplied as raw or wrapped profile JSON.
Missing or malformed state is treated as no profile where the calling workflow
allows it. Storage-state files can contain cookies and local-storage credentials
and must be treated as secrets.

Do not log cookie values, passwords, storage state, or complete sensitive Flow
variables. Use template references for passwords. Use `ArtifactWriter` and the
existing schema/path helpers instead of writing replay artifacts with arbitrary
paths. Validate/sanitize flow IDs, run IDs, filenames, and any generated
directory segments. Downloads and crops must remain beneath their intended
artifact/output roots.

## 12. Change and validation guidance

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
```

For an Electron integration change, also exercise the relevant user path:
record one navigation/click/input sequence and stop; replay a successful Flow
and inspect a failure report; or test the affected IPC/UI workflow. Packaging
checks are needed when the packaging script or packaged resources change.
