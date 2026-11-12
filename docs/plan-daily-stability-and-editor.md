# Today's critical tasks — instruction (handoff brief)

Two tasks for today. T1 (recorder/engine) and T2 (renderer UI) touch disjoint
files and can run in parallel; sequence commits accordingly. Follow
`AGENTS.md` invariants throughout; baseline checks after each task:

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

## Deferred — Pi auto-execution on replay error (under discussion, NOT today)

Decision: replay errors keep the current behavior (Pi advice in the AI pane);
automatic execution of recovery steps is deferred pending discussion.

Open questions to resolve before scheduling it:

1. **Embedded-browser fidelity**: the `WebContentsView` is the same Chromium
   build Electron ships, driven through the same CDP/Playwright mechanism used
   against native Chrome — recording/replay semantics are equivalent. The
   deltas that matter for AI-driven recovery are behavioral, not engine-level:
   no user profile/extensions, Electron-owned dialogs and window.open, shared
   session partitions, and viewport/DPR under window control. These need a
   written position before recovery automation is trusted.
2. **Interaction model**: single-shot proposal→validate→execute vs an
   interactive tool-calling session in the Pi worker; SDK tool-registration
   support in the installed `@earendil-works/pi-coding-agent` version must be
   verified.
3. **Guardrails**: mode setting (off/confirm/auto), per-step and per-run
   attempt caps, step-kind allowlist, secrets never entering prompts, and
   audit trail in run artifacts.

The previously drafted two-stage design (executor `onStepFailure` hook +
validated single-shot recovery; host-executed tool surface as stage 2) is in
this file's git history and remains the reference when the discussion
concludes.

---

## Sequencing for today

Start T1 and T2 in parallel (disjoint files: recorder/engine vs renderer).
When each lands, update `docs/technical-architecture.md` (§8 for the capture
hardening, renderer/source-map notes for the editor) and `CHANGELOG.md` per
`docs/changelog-guide.md`.
