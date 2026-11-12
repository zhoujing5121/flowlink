# Startup acceleration — implementation plan (handoff brief)

Goal: remove the three moments where users feel stuck — app cold start, Record
click → capturing, and first AI-pane message — by killing redundant work on the
critical path and prewarming the expensive lazy resources (CDP/Playwright
attach, Pi SDK) while the user is idle.

The implementer needs only this file and the repository.

## 0. Ground rules and current state

- Follow `AGENTS.md`; baseline checks after each workstream:

  ```powershell
  npm run build
  npx tsc --noEmit
  npm test
  ```

- The working tree may contain other in-flight work; do not entangle commits.
- All anchors were verified against the tree at commit `2a9a81f` — if lines
  drifted, the named function is the anchor.

### What already works (do not undo)

- Initial browser URL loads fire-and-forget after `mainWindow.show()`
  (`src/main.ts` `createWindow()` — `void browserView.webContents.loadURL(...)`),
  so slow networks do not delay the window.
- `EngineBridge` defers `connectOverCDP` to the first `pageFor()` call
  (`ensureBrowser()`, `src/engine-bridge.ts` L33–40).
- The Pi SDK is dynamically imported inside a worker thread; the main process
  never loads it (`src/pi-agent-worker.ts` `loadPiSdk()`).
- Startup loads task metadata only; flow details hydrate when a drawer opens.

### The three latency paths (verified)

**Record click** (`renderer/bridge.js` `startBrowserRecording()` L409 → IPC
`recording:start` `src/main.ts` L1018):

1. Renderer awaits a full navigation to the draft URL when it differs from the
   current page (L416–422).
2. Main's `resetBrowserTabs()` (`src/main.ts` L307–340) then always runs
   `await browserView.webContents.loadURL(startUrl)` (L339) — **a guaranteed
   second full page load of the same external URL on every Record click**,
   including a forced reload when the page is already at `startUrl`.
3. `resetBrowserTabs` calls `engine.forgetAll()` (L323) even though its loop
   already forgets the tabs it destroyed (L319), so no cached Playwright `Page`
   survives.
4. First `engine.pageFor()` pays `connectOverCDP` plus the 40-attempt marker
   discovery loop (~100–500 ms cold).
5. `record()` additionally awaits `page.waitForLoadState('load')`
   (`engine/recorder/src/record.ts` L548) — a second sequential wait for load.

**First AI message** (`src/pi-agent.ts` `runPiPrompt()`): worker spawn →
`import('undici')` → `import('@earendil-works/pi-coding-agent')` (the big one:
a large module graph, seconds cold) → `ModelRuntime.create` →
`createAgentSession` → provider round trip. The runtime cache exists
(`createRuntime()` keyed by authPath/provider/model in
`src/pi-agent-worker.ts` L82–109) but is only filled by the first real prompt.

**Cold app start**: `dist/main.js` statically imports `playwright-core`
(via `src/engine-bridge.ts` L14 and the engine modules `src/main.ts` pulls in),
so Node parses the whole Playwright module graph before `app.whenReady` fires.

## 1. Workstream W1 — timing instrumentation (do this first)

Add a tiny perf helper (e.g. `const t = perf(); ... t.mark('recording:start')`
using `Date.now()`; prefix all lines with `[perf]`) and log at these
boundaries:

- `recording:start` handler: enter, after `resetBrowserTabs`, after `pageFor`
  (primary), after all-tab attach, after capture install, exit.
- `engine-bridge.ts` `ensureBrowser()`: connect duration; `pageFor()`: cache
  hit vs discovery, attempts used.
- Pi worker: worker spawned, SDK import done, `ModelRuntime.create` done,
  `createAgentSession` done, provider response received.
- `app.whenReady` → `loadFile` done → `show()`.

Cheap, always-on for now (one line per boundary, not per event). These logs are
the before/after evidence for every other workstream; record a baseline run
before touching anything.

## 2. Workstream W2 — kill the redundant Record-click navigation

In `resetBrowserTabs()` (`src/main.ts` L307–340):

1. Normalize both URLs and **skip `loadURL` entirely when the current URL
   already equals `startUrl`** (compare origins + path + query; ignore hash).
   This alone removes a full external page load from every normal Record click
   where the draft equals the current page or the renderer just navigated.
2. When a navigation IS needed, stop double-waiting for load: trigger
   `void browserView.webContents.loadURL(startUrl).catch(() => {})` and await
   at most `domcontentloaded` (or nothing) — `record()`'s existing
   `waitForLoadState('load')` (record.ts L548) becomes the single load gate.
   Keep `withAbort`/stop-signal semantics intact: Stop during startup must
   still abort promptly, which `waitForLoadState` in the recorder already
   handles via its stop wrapper.
3. Renderer side (`renderer/bridge.js` L416–422) stays as-is in this
   workstream (its draft navigation is then the only load). Optional follow-up,
   not required: demote its await the same way.

**Documented tradeoff** (put a comment at the skip): skipping the reload means
the recording baseline is the current DOM, not a freshly loaded page — matching
`preservePage` semantics. If a guaranteed-clean baseline is ever required, make
it an explicit "reload before record" option rather than reverting the skip.
Note the recorder already treats an existing page as seed context (no initial
navigation event), so no recorder change is needed.

Acceptance: with the app already on the start URL, clicking Record causes no
visible reload and `[perf] recording:start` exit-to-exit is well under a
second (network-independent).

## 3. Workstream W3 — CDP/Playwright prewarm + stop dropping the cache

1. **Startup prewarm**: after `waitForCdpPort()` succeeds in
   `app.whenReady` (`src/main.ts` L469–475), add
   `void engine.pageFor(activeBrowserTabId, browserView.webContents).catch(() => {})`.
   Fire-and-forget: failure must never block or fail startup; `recording:start`'s
   `if (!engine) throw` guard stays.
2. **Stop dropping the cache**: in `resetBrowserTabs()`, delete the
   `engine?.forgetAll()` call (L323) — the loop above it already forgets each
   destroyed tab individually. The primary `browserView` is never destroyed
   there, and a cached Playwright `Page` remains valid across `loadURL`
   navigations (the CDP target persists; the window marker is only needed for
   initial discovery — `pageFor`'s cache check is `cached && !cached.isClosed()`,
   `src/engine-bridge.ts` L43–48).
3. Keep `forgetAll()` (or per-tab forget) in the full-reset path — the
   `browser:restart` handler — where the primary `webContents` is actually
   recreated; after that reset, re-prewarm in the background the same way.
4. Result: at Record click, `pageFor` returns the cached Page in ~0 ms, and
   additional-tab attach runs without paying `connectOverCDP`.

Acceptance: `[perf] pageFor` shows `cache` on Record click; first-ever Record
after startup shows `connect` once (the prewarm), not at click time.

## 4. Workstream W4 — Pi prewarm at idle

1. **Worker side** (`src/pi-agent-worker.ts`): the message handler currently
   runs `runPrompt` for every message. Add a `kind: 'prewarm'` request: it
   performs `loadPiSdk()` + `createRuntime(request)` (which caches by
   authPath/provider/model — the existing mechanism, L82–109) and replies
   `{id, ok: true}`; errors reply `{ok: false}` and are ignored by main. No
   provider request is made — never spend tokens to warm up.
2. **Main side** (`src/pi-agent.ts`): export `prewarmPi(): Promise<void>` that
   (a) calls the same settings/auth validation used by `piStatus()` — if it
   throws, return silently (Pi unconfigured is a normal state; no error
   logging), (b) sends the prewarm message through the existing worker
   plumbing without a user-facing timeout, (c) unrefs the worker afterwards as
   today. If a real prompt is in flight, the prewarm message simply queues
   behind it — that is fine.
3. **Triggers**:
   - `src/main.ts`: `setTimeout(() => void prewarmPi().catch(() => {}), 1500)`
     after `mainWindow.show()`.
   - New IPC `pi:prewarm` handler + `pi.prewarm()` in `src/preload.ts`; the
   renderer calls it when the AI pane opens (the `state.aiOpen = true` paths in
   `renderer/app.js`, e.g. `startAIAdvice()` and the AI toggle handler).
   Whichever fires first wins; subsequent calls are cheap no-ops (worker
   already warm).
4. After prewarm, the first real message pays only `createAgentSession` plus
   the provider round trip — the irreducible part.
5. **Known limitation, document it**: background auto-refine and pane messages
   share one serialized worker. A user messaging right after a recording stop
   may queue behind a long generation. Surface the existing `ai:autoRefine`
   state in the pane if it bothers users; do NOT add a second worker in this
   change.

Acceptance: after the app has been idle ≥2 s (or the pane has been opened),
`[perf]` shows the first prompt's request path contains no SDK import or
runtime creation; first-token latency ≈ network only.

## 5. Workstream W5 — lazy `playwright-core` import

`playwright-core` must not be in the main bundle's startup import graph.

1. `src/engine-bridge.ts` L14: keep `import type { Browser, Page }`, replace
   the value import with a cached dynamic import inside `ensureBrowser()`
   (`const { chromium } = await import('playwright-core')`, memoized).
2. Sweep the modules `src/main.ts` transitively imports for other **value**
   imports of `playwright-core`: `grep -rn "from 'playwright-core'" src/ engine/`.
   Known case: `engine/executor/src/run.ts` (and `batch.ts`) import `chromium`
   for standalone (non-Electron) launches — make those dynamic at the launch
   site too. Type-only imports are erased by esbuild and can stay.
3. Verify with the build: `node build.mjs` metafile (or a quick
   `node --input-type=module -e "import('./dist/main.js')"` timing harness in
   dev) — the acceptance is the `[perf]` cold-start line improving and no
   Playwright frames in the startup path.
4. `undici` and the Pi SDK are already dynamic-only — leave them.

Acceptance: cold start `[perf]` whenReady timing improves; app and recording
behavior unchanged (dynamic import resolves on first `ensureBrowser`, i.e.
during the W3 prewarm, still off the user's path).

## 6. Sequencing and validation

W1 → (W2, W3, W4 in any order — independent; W2 is the biggest user-visible
win) → W5. Each is one small, reviewable commit.

Final validation:

- Baseline checks (`npm run build`, `npx tsc --noEmit`, `npm test`).
- AGENTS.md manual scenarios: record start-URL navigation/click/input and stop;
  flow load and replay; one AI-pane advice message.
- Timing comparison using the W1 logs, on the real target network:
  cold start, Record click on already-loaded page, first AI message after idle.
- Recording-cancel semantics: Stop during `recording:start` still aborts
  promptly (W2 touches the awaited navigation) — verify with a slow start URL
  and an immediate Stop.
- No packaging changes (none of this touches scripts/resources).

Update `docs/technical-architecture.md` §4 (Startup) with the prewarm behavior
and `CHANGELOG.md` per `docs/changelog-guide.md` when done.

## 7. Risks and traps

1. **W2 changes the recording baseline** to the current DOM when skipping the
   reload (same as `preservePage`). Intentional; keep the code comment and do
   not add hidden heuristics. If a site leaves the page in a broken mid-state,
   the user can reload via the browser toolbar before clicking Record.
2. **Stop-vs-start races**: `resetBrowserTabs` currently awaits navigation,
   which gives Stop a natural cancellation point. After W2, the awaited part
   shrinks — confirm `withAbort` + the recorder's stop wrappers still abort
   promptly (scenario in §6).
3. **Stale cached Page**: only dangerous when the primary `webContents` is
   destroyed and recreated — that happens in `browser:restart`, which keeps
   `forgetAll()`. Do not remove forgetting there.
4. **Pi prewarm with unconfigured/invalid Pi**: must be fully silent. Also
   guard against settings changing between prewarm and first prompt — the
   runtime cache is keyed by authPath/provider/model, so a settings change
   naturally misses the cache and re-creates; no extra invalidation needed.
5. **W5 import sweep**: a single remaining static value import anywhere in the
   main graph keeps Playwright on the startup path. The grep in W5.2 is the
   checklist; engine modules not imported by `src/main.ts` (e.g. `batch.ts`
   today) are optional but cheap to convert.
6. **Do not prewarm by pinging the provider** — no network calls in prewarm;
   tokens cost money and offline environments would log noise.
