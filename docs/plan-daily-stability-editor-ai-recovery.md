# Today's critical tasks — instruction (handoff brief)

Three tasks, ordered by user priority. T1 (recorder/engine) and T2 (renderer
UI) touch disjoint files and can run in parallel with T3 (executor + Pi); the
only shared file is `src/main.ts` (T3 only) — sequence commits accordingly.
Follow `AGENTS.md` invariants throughout; baseline checks after each task:

```powershell
npm run build
npx tsc --noEmit
npm test
```

Anchors were verified at commit `2a9a81f` + current working tree; if lines
drifted, the named function is the anchor.

---

## T1 — Make recording and action capture more stable

### What already works (do not re-fix)

Capture reinjection on navigation is handled: `record()` re-installs the
idempotent capture script on `domcontentloaded` / `frameattached` /
`framenavigated` (`engine/recorder/src/record.ts` L434–442), `capture.js` has a
document-level install guard, and popups get `installCaptureOnPage` because
context-level `addInitScript` misses their first document
(`engine/recorder/src/capture-client.ts` L85–122). The buffer flush is
serialized through one promise chain so Stop cannot double-consume a batch.

### Tasks

1. **Instrument first** (half day cap): reuse the `[perf]` pattern — log per
   recording session: raw events received, events dropped or re-queued,
   `processBatch` failures, capture reinjection attempts that returned
   `false` (frame not installable), attach attempts used in
   `EngineBridge.pageFor`, pages attached/detached. Without counts, the rest
   is guesswork.
2. **Stop losing events on batch failure** — `record()`'s flush catch today
   pushes a warning and the batch is gone (`processBatch` failure path,
   `record.ts` ~L1095 area). Requeue the batch once with a cap; if it fails
   again, keep the raw events in the evidence stream (they already flow there)
   and warn with the batch's event ids.
3. **Fix the known cross-batch drag gap** — the coalescer is stateless per
   batch (`coalesce.ts`), so a `dragStart` and its `drop` in different flush
   windows never pair. Thread a pending-drag slot through options the way
   `record()` threads `tabState` across batches (see the hover cross-batch
   precedent in `processBatch`).
4. **Harden page lifecycle during recording**:
   - `page.on('crash')` / `close` on attached pages: stop recording THAT page
     gracefully (warn, keep other tabs alive) instead of letting listeners
     throw into the flush chain.
   - Popup attach at `record.ts` ~L530 is fire-and-forget
     (`void installCaptureOnPage(opened).catch(...)`); give it the same
     bounded retry as the main page and log when a popup is never captured.
   - `EngineBridge.pageFor` marker loop: when all 40 attempts are exhausted,
     log attempts used and the CDP contexts seen — today it surfaces as a bare
     attach failure with no diagnosis.
5. **Regression tests for coalescing/planning edge cases** in
   `tests/flow-authoring.test.mjs` (pure modules, fast):
   double-click merge boundaries, input merge window split by an intervening
   click, navigation dedupe vs host `userNavigateRequested` (30 s window),
   back-to-back drags, hover suppression after click, `switchTab` insertion
   from host timeline vs page-index change.
6. **Stop-path timing**: `stopRecordingCapture`'s fixed `sleep(850)`
   (`src/main.ts` L433) — make it event-bounded (wait for last frame or
   flush-chain drain, hard cap 850 ms) so Stop is not artificially slow on
   fast machines nor racy on slow ones.

### Acceptance

- A recording session logs zero unexplained dropped events on the manual
  scenarios below; killing one tab mid-recording does not end the session.
- Drag recorded as one step even when start/drop straddle the flush window.
- Manual stability matrix passes: SPA pushState/hash navigation, one
  cross-origin iframe page, slow network (throttled start URL), a dialog
  during load, popup tab capture, multi-tab switch-back, Stop during startup.

---

## T2 — Optimize Add-step and Group functions (UI + functionality)

### Current state (anchors)

- New group uses a blocking `window.prompt("New group name", …)`
  (`renderer/app.js` L4018) — native prompt, no validation, inconsistent with
  the new green UI.
- Manual step editor: `showManualStepEditor(item, groupId)` (opened from the
  per-group add-step button, L4360–4365); the per-group button is disabled
  until `item.processFlow` is hydrated (L796–798).
- Group insert (before/after) mutates `item.processFlow.steps` locally
  (L4620–4626); persistence goes through the validated `flow:updateSteps` IPC
  (contract: unique group ids, non-empty groups, condition = final direct step
  of its group targeting existing non-empty top-level groups).
- Per AGENTS.md, new UI structure belongs in `renderer/index.html` templates —
  including any new dialogs.

### Tasks

1. **Replace `window.prompt`** with a proper `<dialog>` template in
   `index.html` (name field + optional description, focus trap, Enter/Esc),
   styled with the green theme; same for any other `window.prompt` in the
   workspace (`grep -n "window.prompt" renderer/app.js` — replace all).
2. **Manual step editor fit**:
   - Audit `showManualStepEditor`'s supported kinds; present a kind picker
     limited to what is valid IN CONTEXT (element kinds only when recorded
     `ElementRef`s exist — offer an element picker sourced from the flow's
     existing steps; `condition` only as the final step of a group; no
     `script` steps from the UI).
   - Surface contract errors inline: `flow:updateSteps` re-parses and throws
     validation messages — show them in the dialog instead of failing the save
     silently; keep the user's input.
   - After a successful save, rehydrate the Process view from the returned
     flow (already returned by the IPC) without a full drawer reload.
3. **Group operations parity**: rename, move up/down, delete (with confirm),
   and merge into adjacent — all via `flow:updateSteps`, with the 01/02 group
   numbering recomputed after each operation.
4. Wire the add-step / group buttons to per-group enablement correctly
   (disabled with a tooltip explaining WHY: flow not loaded / recording in
   progress), so the UI never looks dead.

### Acceptance

- Create/rename/reorder/delete groups via dialogs; add a wait, a navigate, a
  condition branch, and an element step that references a recorded element;
  invalid condition target shows an inline error and the flow is unchanged.
- `grep -c "window.prompt" renderer/app.js` → 0.
- Manual scenario per AGENTS.md IPC/UI entry, plus one full record → edit →
  replay round trip.

---

## T3 — Enable Pi to auto-execute recovery steps on replay error

### Answer: yes — implementable, in two stages, WITHOUT giving Pi raw browser control

The architecture already has the right seams:

- The executor can pause mid-run for a host callback — the
  `waitForUserOperation` option (`engine/executor/src/run.ts`, userOperation
  wait branch) is the exact pattern to copy for a failure hook.
- Mutable resolution data (`candidates`, `selfHealed`) is the sanctioned place
  for healing output; `observed` stays immutable.
- The AI generation pipeline (`src/ai-refine.ts`, `pi:generateFlow`) already
  proves prompt → validated-step flows.
- The Pi worker is text-only today (`noTools: "all"` in
  `src/pi-agent-worker.ts`) — which is precisely why Pi can currently only
  advise. Tool support exists in the SDK (that is what `noTools` disables);
  verify the custom-tool registration API of the installed
  `@earendil-works/pi-coding-agent` version before Stage 2.

**Why not raw control:** handing Pi free-form Playwright/CDP access would
violate the repo's own contract (executor actions must go through resolver
APIs, never ad-hoc locators), put rendered variable values — including
secrets — into prompts, and produce unauditable runs. Scoped, host-executed
tools avoid all three. That is the design below.

### Stage 1 — single-shot auto-recovery (build today)

1. **Executor hook**: add `PlayOptions.onStepFailure?: (ctx: {
     stepId, index, error, renderedStep }) => Promise<RecoveryDecision |
     undefined>` where `RecoveryDecision = { action: 'retry' } | { action:
     'replace', step: Step }`. Call it in `run.ts` where a step fails and
     `stopOnFailure` would abort — only once per step, max 3 recoveries per
     run. `replace` steps run through the SAME `runAction` path (resolver,
     verification, artifacts) as normal steps.
2. **Host orchestration** (`src/main.ts` `playback:run`): implement the hook —
   if Pi is unavailable or `aiRecovery` is disabled, return `undefined` (run
   fails exactly as today, then the existing `startFlowLinkAIAdvice`
   replay-failure advice flow opens). Otherwise build the recovery prompt in
   `src/ai-refine.ts` style: failed step (compacted `$ref` view — secrets
   NEVER rendered, keep `{{templates}}`), error code/message, the page outline
   from the existing `snapshotPage` pull API, and the run's step history
   summary. Pi returns JSON `{ action: 'retry' | 'replace' | 'abort',
   step?, rationale }`.
3. **Validate before executing a `replace` step**: schema-parse the step; for
   element targets, allow a **runtime locator hint** (this is the one place
   new selectors are acceptable) — but it must resolve through the resolver
   with a unique, validated match before execution. If it does not resolve
   uniquely, treat as abort. Persist nothing into `observed`; a successful
   recovery appends to the run's step results with an `aiRecovered` note and
   to `flow.selfHealed` (write-back only under the existing write-back rules).
4. **Guardrails**: setting `aiRecovery: 'off' | 'confirm' | 'auto'` in
   `config/pi-settings.json` (default `'confirm'` — one click "Apply AI fix?"
   in the pane; `'auto'` for full auto-execution), one attempt per step, three
   per run, step-kind allowlist for `replace` (navigate, click, input, select,
   key, wait, assert, dialog — no `script`, no `upload`), every recovery
   logged into the run's `log.txt` and visible in the Test view.
5. **Renderer**: reuse the `playback:userOperation` banner pattern for
   `confirm` mode; show "AI recovering step N…" status; a failed/aborted
   recovery falls back to today's advice message automatically.

Stage 1 needs **no Pi SDK tool registration** — it is one bounded prompt plus
host-side execution, i.e. genuinely "Pi auto-executes the fix".

### Stage 2 — interactive recovery tools (follow-up, after today)

Make the worker session interactive (worker ↔ main tool-call messages over
`postMessage`) and register host-executed tools with `createAgentSession`.
The tool surface — thin wrappers over existing engine APIs, never raw
Playwright:

| Tool | Backed by | Guardrail |
|---|---|---|
| `getFailureContext()` | run report entry + compacted step | secrets stripped |
| `getPageOutline()` | `snapshotPage` / `__rrSnapshot` | node-capped |
| `findElements(description)` | engine/resolver candidate search | unique-match required |
| `inspectElement(ref)` | observed-facts summary of one candidate | no full-page dump |
| `executeStep(step)` | executor `runAction` | kind allowlist, once per call |
| `retryStep()` | executor | — |
| `finishRecovery(outcome)` | host | resumes or fails the run |

Bounded turns (≤8 tool calls per recovery), same per-run caps and settings as
Stage 1. If the installed SDK version cannot register host tools, keep the
Stage-1 loop but iterate it: host sends the execution result back as a
follow-up prompt (≤2 rounds) — still auto-execution.

### Acceptance (Stage 1)

- A flow with a deliberately broken step (rename a target's css candidate) —
  in `confirm` mode the pane offers the AI fix, one click applies it, the run
  continues and the report marks the step `aiRecovered`; in `auto` mode no
  click is needed; in `off` mode behavior is byte-identical to today.
- A recovery that cannot resolve uniquely aborts cleanly and the original
  error report is preserved.
- No secret variable value ever appears in a `[perf]`/debug log or a recovery
  prompt (assert by inspecting the prompt builder with a `{{password}}`
  variable set).

---

## Sequencing for today

Start T1 and T2 in parallel (disjoint files). T3 Stage 1 after or alongside —
its executor hook (`run.ts`) and prompt work (`ai-refine.ts`, `main.ts`) do
not overlap T1's recorder files or T2's renderer files. T3 Stage 2 is
explicitly NOT today. Update `docs/technical-architecture.md` (§9 replay for
the failure hook, §11 for aiRecovery), `docs/architecture.md`, and
`CHANGELOG.md` per `docs/changelog-guide.md` when each task lands.
