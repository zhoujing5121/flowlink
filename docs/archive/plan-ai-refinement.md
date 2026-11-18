# AI refinement update — implementation plan (handoff brief)

Three features, one shared pipeline:

1. **Auto-refine on stop** — after a recording stops and persists, the app
   automatically calls Pi to sanitize and group the raw recording; the response
   is parsed into a NEW recording named with the `REFINED` prefix and saved
   exactly like a recorded flow.
2. **`@` flow mentions in the AI pane** — the user types `@` to attach flows,
   writes an instruction, sends; the app calls Pi to generate a new flow and
   saves it as a new recording.
3. **Refine button** — works with one or more selected flows (today it enables
   with one selection but the click is a silent no-op), opens the AI pane with
   selectable preset options plus free text; the rest follows the same pipeline.

The implementer needs only this file and the repository.

## 0. Ground rules and current state

- Follow `AGENTS.md` invariants. Flow saves must pass Zod parsing and contract
  validation. Never send secret variable values anywhere — secrets are not
  persisted in flows (only `{{templates}}` and non-secret defaults), so flow JSON
  sent to Pi never contains credentials. Do not log flow contents.
- Baseline checks at the end of every milestone:

  ```powershell
  npm run build
  npx tsc --noEmit
  npm test
  ```

- The working tree currently holds **uncommitted** FlowForge-gaps work
  (`engine/recorder/src/classify.ts`, `systems.ts`, coalesce/drag changes,
  `config/classification.example.json`). Build on top of it; do not revert or
  entangle it with this work.

### What already exists (anchors)

| Piece | Where | Notes |
|---|---|---|
| Pi worker + IPC | `src/pi-agent.ts`, `src/pi-agent-worker.ts`, `pi:status` / `pi:prompt` handlers in `src/main.ts` (~L1190) | Worker is text-only (`noTools: "all"`), forced system prompt, 100k-char prompt cap, timeout clamp [5 s, 600 s] |
| System prompt | `src/pi-agent-worker.ts` `SYSTEM_PROMPT` | Already defines the `{title, summary, steps, rationale, risks}` JSON contract |
| AI pane | `renderer/app.js` `renderAIPanel()` (~L1926), markup `renderer/index.html` (~L560–640) | Chat stored per item as `item.chat` (`{role, text}`), composer `#assistantInput` + `#assistantSend` |
| Send path | `submitAssistantMessage()` → `invokeAIMerge(option, prompt)` (~L2194) | Regex heuristic `aiRequestNeedsMaterial()` (~L2092) decides advice vs. material |
| Generation (today) | `generateRefinedMaterial(sourceItems, request, parentItem)` (~L2120) | Builds prompt in the renderer with FULL step JSON (`slice(0, 65000)`), calls `pi.prompt`, strips code fences, `JSON.parse`, persists via `recording:persistMerged`. **No schema validation before persist; no element-reference protection; prompt cap can truncate JSON.** |
| Advice | `askPiForAdvice()` (~L2103), `aiMaterialContext()` (~L2067) | Sends compact-ish context + last 8 chat turns |
| Save as new recording | IPC `recording:persistMerged` (`src/main.ts` ~L825) | Creates `RecordingMeta { isMerged: true }`, fresh `recording-…` id; renderer marks item `summary: true` → "Refined" badge (~L1062) |
| Auto-advice on stop | `renderer/bridge.js` ~L680 `window.startFlowLinkAIAdvice({mode:'recording-complete'…})` on `recording:done` | Opens pane with advice; does not generate |
| Refine button | `#summarizeRecordings` (`index.html` L644), wired at `app.js` L1009 | **Bug:** `updateSummaryState()` (~L1113) enables on any `checked` item, but `summarizeRecordings()` (~L1537) requires `checked && analyzed`, rejects mixed selections, and returns **silently** — hence "enabled but nothing happens" |
| Recording names | `generatedRecordingName()` `src/main.ts` L132 → `RECORD-YYYY-MM-DD` | |

## 1. Target architecture

```text
AI pane (renderer)                     main process
──────────────────                     ───────────────────────────────────────
chat text + attachment IDs  ──IPC──▶  pi:generateFlow
                                       src/ai-refine.ts
                                         ├─ load source flows (by recording id)
                                         ├─ project to compact steps + $ref element library
                                         ├─ build prompt (instruction + conversation)
                                         ├─ runPiPrompt (worker)
                                         ├─ extract JSON → rehydrate $refs → parseFlow + contract
                                         └─ return VALIDATED proposal (not saved)
review in pane ──IPC──▶ recording:persistMerged   (user-driven refine)

recording:stop ──▶ autoRefineRecording()  (same pipeline, internal call,
                       saves directly, emits ai:autoRefine event)
```

### Clean-conversation rules (explicit requirement)

- `item.chat` entries hold `{role, text, attachments?: [{id, name}]}` — **never
  flow JSON**. The chat transcript renders text plus small attachment chips.
- The composer carries `state.aiAttachments: string[]` (recording ids). Flow
  payloads are assembled in the **main process** from the store; the renderer
  passes ids only. This bounds chat memory, keeps the transcript readable, and
  means a 300-step flow costs nothing in UI state.
- Generation status messages in chat are short strings ("Pi is preparing a
  refined material…"), as today.

### Element-reference protocol (`$ref`) — the core safety mechanism

Full `ElementRef`s (observed facts, candidates, fingerprints, crops) are large
and must stay immutable record-time evidence — Pi must not rewrite or invent
them. Therefore:

- **Projection** (main): every `target` / `from` / `to` ElementRef in the source
  steps is replaced by `{"$ref":"eN"}`. A library maps `eN → deep-clone source`
  (`recordingId + stepId + field`). The prompt shows each library element once as
  a one-line summary: `e3 · button "Submit" · css #submit · fingerprint ok`.
- **Generation** (Pi): output steps reference elements ONLY as `{"$ref":"eN"}`.
  Pi may freely add steps that need no element (`navigate`, `wait` with
  `timeout`/`networkIdle`, `assert` with url/title assertions, `group`), reorder,
  delete, and re-group steps — but cannot fabricate locators.
- **Rehydration** (main): walk output steps; replace each `{"$ref"}` with the
  cloned recorded ElementRef. Unknown `$ref` id, or any inline element object in
  those fields → reject with a precise error naming the step. Then `parseFlow` +
  `validateFlowContract` (schema v2 rules: unique group ids, non-empty groups,
  condition targets exist, candidates ascending…).
- Step `id`s are preserved from the source in the projection so Pi can keep,
  drop, or nest them; the pipeline de-duplicates colliding output ids by
  suffixing `-2`, `-3`.

### Variables

The pipeline merges `variables` from all source flows (non-secret defaults win
in first-source order). Pi is instructed NOT to output `variables`; if it does,
only non-secret entries with valid names are merged.

## 2. Prompts (verbatim)

### 2.1 System prompt additions (`src/pi-agent-worker.ts` `SYSTEM_PROMPT`)

Append after the existing JSON-contract paragraph:

```
Element references: recorded elements are provided as an element library.
In output steps, target/from/to must be exactly {"$ref": "eN"} referencing a
library id. Never inline element data, selectors, or coordinates. You may add
steps that need no element (navigate, wait with condition timeout/networkIdle
or userOperation, assert with url/title, dialog, group), but never invent
selectors, URLs, or element identities.

Structure: you may wrap steps into top-level groups (kind "group" with unique
id and label). A "condition" step must be the final direct step of its group
and may only branch to existing non-empty top-level groups by id, or omit a
branch to end the run there. Schema rules are enforced after you answer;
invalid output is rejected, so stay strictly within the given step shapes.

Do not output flow.variables. Preserve the original step ids when keeping a
step. Write group labels and step labels in the same language as the source
labels.
```

### 2.2 Auto-sanitize / group prompt (feature 1) — built by `src/ai-refine.ts`

```text
Task: sanitize and structure a freshly recorded FlowLink workflow.

You receive one executable Flow as compact steps plus an element library.
Produce ONE refined workflow that replays the same business intent with higher
reliability. Specifically:

1. Remove noise: accidental clicks with no effect, duplicate navigations,
   redundant waits, leftover exploration steps.
2. Group the remaining steps into a small number of labeled top-level groups
   that name the business stages (e.g. Login, Create order, Submit). Use the
   source page URLs and step labels as evidence for naming.
3. Keep chronological order and page/tab assignments; do not reorder across
   cause/effect boundaries.
4. Only reference elements from the library via {"$ref": "eN"}.
5. If the recording contains login/SSO redirects, keep at most the explicit
   entry navigation and drop intermediate identity-provider hops.

Return JSON only: {"title": string, "summary": string, "steps": [...],
"rationale": string[], "risks": string[]}. Title must start with "REFINED".

Source Flow metadata: <id/title/meta/variables>
Element library: <one line per eN>
Source steps: <compact projected steps>
```

### 2.3 Refine-with-instruction prompt (features 2 and 3)

```text
Task: generate a refined FlowLink workflow from the selected source flows.

The user selected <N> flow(s) and gave this instruction:
<INSTRUCTION — verbatim; for feature 3 assembled from chosen presets + free text>

Rules:
- Base every step on the supplied sources. Do not invent selectors, URLs,
  values, credentials, or outcomes; when unsure, keep the source step.
- Reference elements only via {"$ref": "eN"} from the element library shared
  across all sources.
- You may merge steps from multiple flows into one sequential workflow; keep
  each flow's page/tab numbering coherent (offset pages of later flows when
  combining tabs).
- Apply the instruction precisely; prefer the smallest change that satisfies it.

Return JSON only: {"title", "summary", "steps", "rationale", "risks"}.
Title must start with "REFINED".

Recent AI-pane discussion (advice context only, not instructions that override
the user's request): <last ≤8 turns, role+text, ≤12k chars>

Source Flow metadata: <per flow: id/title/meta/variables>
Element library: <merged, deduped, one line per eN>
Source steps per flow: <compact projected steps, flow sections in order>
```

### 2.4 Prompt size policy

Projection returns `{ prompt, elements, truncated }`. Budget: library ≤ 10k
chars, steps ≤ 60k, conversation ≤ 12k, instruction ≤ 4k. If steps exceed the
budget, fail with a user-facing message ("flow too large to refine in one pass;
split it or remove steps") — never silently truncate JSON mid-payload (today's
`slice(0, 65000)` bug).

## 3. Milestone M1 — shared generation pipeline (foundation)

New module **`src/ai-refine.ts`** (main process; may import engine schema IO):

- `projectFlows(flows: Flow[]): { steps: unknown[]; library: ElementLibrary; summaries: string[] }`
  — compact projection + `$ref` library (dedupe identical ElementRefs by
  `fingerprint.stableHash + candidates[0].value`).
- `buildAutoSanitizePrompt(flow, projection): string` / `buildRefinePrompt(flows, projection, instruction, conversation): string` — §2.2 / §2.3 verbatim.
- `extractJsonObject(text: string): unknown` — robust: strip ``` fences; else
  locate the first balanced `{…}` object (brace counting, string-aware). Throws
  with a clear message on failure.
- `rehydrateSteps(steps: unknown[], library): Step[]` — §1 protocol; deep-clone
  refs; reject unknown ids / inline elements; de-duplicate ids.
- `generateRefinedFlow(options): Promise<GenerateResult>` where options =
  `{ flowFiles: string[]; instruction?: string; conversation?: {role,text}[]; timeoutMs? }`
  and result = `{ ok: true; flow: Flow; title; summary; rationale; risks } |
  { ok: false; error }`. Internally: `loadFlow` each → project → prompt →
  `runPiPrompt` (timeout default 180 000, clamped) → extract → rehydrate → merge
  variables → `parseFlow({ ...base, id: makeId('flow'), version: 1, steps,
  title }, '<ai-refine>')` — validation errors are returned verbatim in `error`.
  **Does not save.**
- `persistMergedFlow(taskCode, flow, name)` — extract the body of the existing
  `recording:persistMerged` handler (`src/main.ts` ~L825) into this function;
  the IPC handler and auto-refine both call it.

IPC + preload:

- `src/main.ts`: `ipcMain.handle('pi:generateFlow', …)` → `generateRefinedFlow`
  (input: `{ taskCode, recordingIds: string[], instruction?, conversation? }`;
  resolves recording ids → flow files via `taskStore`, mirroring
  `flow:updateSteps`).
- `src/preload.ts`: `pi.generateFlow(opts)`; keep `pi.prompt` for advice.

Tests (extend `tests/flow-authoring.test.mjs`, esbuild-bundle `src/ai-refine.ts`):

- projection replaces every ElementRef and round-trips through rehydration to a
  deep-equal original;
- rehydration rejects unknown `$ref` and inline element objects;
- `extractJsonObject`: plain, fenced, prose-wrapped, garbage;
- merged variables keep first non-secret default;
- id de-duplication.

## 4. Milestone M2 — Refine button + options mode (fixes the no-op bug)

1. **Fix the mismatch** (`renderer/app.js`): make `updateSummaryState()` (~L1113)
   enable only when at least one item is `checked && analyzed` and no checked
   item is un-analyzed (same predicate as the handler), and make
   `summarizeRecordings()` (~L1537) show an inline notice instead of returning
   silently when its guard fails. Single selection is fully supported.
2. **Options mode**: `summarizeRecordings()` opens the pane in refine mode — set
   `state.aiMode = 'refine-options'`, `state.aiSourceIds = chosen ids`,
   `state.aiOpen = true`. `renderAIPanel()` renders, in place of the step list,
   a small form:
   - presets (checkboxes): `Group steps into labeled stages` · `Remove redundant
     or accidental steps` · `Add stability waits around page transitions` ·
     `Add assertions for key outcomes` · `Move repeated text inputs into
     Reference variables`;
   - free-text textarea ("Anything else?");
   - `Continue` button.
   Escape/close cancels. `Continue` composes the instruction (selected preset
   sentences + free text) and calls the shared send path with
   `forceMaterial: true`.
3. **Send path**: extend `invokeAIMerge(option, prompt, extra)` with
   `extra.attachments?: string[]` and `extra.forceMaterial?: boolean`. When
   generating: call `window.flowlink.pi.generateFlow({ taskCode, recordingIds,
   instruction, conversation })`; on success reuse the existing
   `generateRefinedMaterial` tail (create item, badge, persist via
   `recording:persistMerged`, assistant summary message with rationale/risks) —
   i.e. refactor `generateRefinedMaterial` to delegate prompt/parse to the IPC
   and keep only the renderer item bookkeeping. On failure show the error in
   chat; the source is untouched.
4. `forceMaterial` bypasses `aiRequestNeedsMaterial` (explicit refine always
   generates); the free-chat heuristic stays for typed messages.

## 5. Milestone M3 — `@` mentions and attachments

1. **Attachment state**: `state.aiAttachments: string[]` on the recording
   session; helper `aiAttachmentItems()` resolves ids → items from
   `taskStore.getRecordings(currentTask)` (already loaded in the drawer state).
2. **Picker**: in `renderAIPanel()`, on `#assistantInput` input, detect an
   unbroken `@query` token at the caret (word-start `@`). Render a dropdown
   above the composer listing the current task's recordings (name + Record /
   Refined badge), filtered by the typed query (max ~8). Keyboard: ↑/↓ move,
   Enter/Tab select, Escape closes. On select: strip the `@query` text, push the
   recording id to `aiAttachments`, re-render.
3. **Chips**: render removable chips (name + ×) between chat and composer;
   clicking × removes the id. Duplicate ids ignored.
4. **Send**: `submitAssistantMessage()` passes
   `{ attachments: state.aiAttachments }`; the pushed chat entry stores
   `{role:'user', text, attachments:[{id,name}]}` and the transcript renders
   chips inside the user bubble (extend the template at ~L2029). Clear
   attachments after send.
5. **Sources**: generation uses attachments when present, else the existing
   `aiSourceIds`/checked selection. Attachments are also valid without any
   instruction for advice calls (`askPiForAdvice` gains them the same way —
   context via `aiMaterialContext` already accepts items).
6. Scope: recordings of the active task only (flows are task-scoped). Extending
   to cross-task mentions is a later UI decision.

## 6. Milestone M4 — auto-refine after recording stops

1. **Trigger** (`src/main.ts`): in the recording-stop persistence path — where
   the recording's Flow is saved and `taskStore.addRecording` succeeds (inside
   `stopRecordingSession`, after the Flow/`RecordingMeta` are durable) — call
   `void autoRefineRecording(taskCode, recordingMeta)` fire-and-forget. Guard
   with an in-flight set keyed by recording id; never block or fail the stop
   response; skip when the source `isMerged` (don't refine a refinement).
2. **`autoRefineRecording`** (in `src/ai-refine.ts` or main): if
   `await piStatus()` is not available → emit `ai:autoRefine {state:'skipped',
   reason}`. Else run the shared pipeline with `buildAutoSanitizePrompt`, then:
   - name: `refinedName(sourceName)` — replace a leading `RECORD` with
     `REFINED` (`RECORD-2026-11-11` → `REFINED-2026-11-11`), otherwise
     `REFINED ${sourceName}`; if a recording with that name already exists in
     the task, append ` (2)`, ` (3)`, …;
   - `persistMergedFlow(taskCode, flow, name)` (isMerged: true — appears in the
     list with the Refined badge, replayable, re-recordable: "treated as a
     recording flow");
   - emit `ai:autoRefine {state:'done', taskCode, sourceRecordingId,
     refinedRecordingId, name}`; on failure emit `{state:'failed', error}`. The
     raw recording is always left intact.
3. **Setting**: optional `autoRefine: boolean` in `config/pi-settings.json`
   (default `true`); read in `readSettings()` — absent key means enabled. No UI
   toggle in this milestone.
4. **Renderer**: `renderer/bridge.js` subscribes to `ai:autoRefine` (add to the
   preload event allow-list!): on `done` refresh the task's recordings and show
   a toast ("REFINED-2026-11-11 created from the recording"); on `failed` show a
   dismissible warning; on `skipped` do nothing (Pi not configured is normal).
   The existing auto-advice pane (`recording-complete`) stays as-is; the two Pi
   calls are serialized by the single worker — the refined material usually
   lands shortly after the advice text.
5. **Concurrency note**: the Pi worker processes messages sequentially; an
   in-flight advice prompt delays auto-refine by its remaining duration. That is
   acceptable at current prompt sizes; do not add parallel workers here.

## 7. Sequencing and validation

M1 → M2 → M3 → M4 (each shippable; M2 already delivers user value by fixing the
broken button). Finish with docs: `docs/technical-architecture.md` §11 (AI
assistance) gains the pipeline + `$ref` protocol + auto-refine event;
`docs/architecture.md` recording/replay sections get one line each;
`CHANGELOG.md` per `docs/changelog-guide.md`.

Manual acceptance per feature:

- **M1**: hand-run `pi:generateFlow` from devtools on a saved recording; verify
  the returned Flow passes `parseFlow` and that `$ref` steps carry real recorded
  candidates/fingerprints.
- **M2**: select exactly one analyzed recording → Refine enabled → click opens
  options → choose presets + free text → Continue → new `REFINED …` recording
  appears with badge; original untouched; invalid Pi output surfaces as a chat
  error, nothing saved.
- **M3**: type `@`, pick a flow, send "group this into stages" → new Refined
  recording; the chat transcript shows only text + chip; a 200-step attached
  flow does not slow the pane.
- **M4**: stop a normal recording with Pi configured → Refined twin appears
  (toast + list) without user action; with Pi unconfigured → recording saved,
  `skipped`, no error surfaced; with a forced Pi failure → warning toast, raw
  recording intact.
- Replay one generated Refined flow end-to-end (AGENTS.md manual scenario).

## 8. Risks and traps

1. **Today's `generateRefinedMaterial` truncates step JSON at 65k chars** — a
   large flow silently produces unparseable/invalid output. The new budget
   (§2.4) must fail loudly instead. Do not keep the old slicing.
2. **Never trust element data from the model**: rehydration is the enforcement
   point. An inline element object must be rejected even if it "looks" like a
   valid ElementRef — observed evidence may only come from recordings.
3. **Schema v2 rules apply to generated flows** (group ids unique, condition
  targets exist and are non-empty, candidates ascending). Return validation
   errors verbatim to the pane; Pi retry with the error text is a v2 nicety,
   not required.
4. **`persistMerged` is the only save path** for refined flows — it never
   overwrites; keep it that way. Auto-refine must not bypass it (use the
   extracted `persistMergedFlow`).
5. **Preload event allow-list** must gain `ai:autoRefine`, or the renderer will
   silently never receive it (`src/preload.ts` `valid` array).
6. **Don't break the advice flow**: `pi:prompt` stays; only generation moves to
   `pi:generateFlow`. Advice still sends context from the renderer — acceptable,
   out of scope.
7. **Chat cleanliness is a hard rule**: no flow JSON in `item.chat`, ever; tests
   should assert the stored entry shape after M3.
8. **Worker prompt cap (100k)**: the budget in §2.4 keeps the total under it;
   enforce with a final length check before dispatch.
9. **Uncommitted FlowForge-gaps work in the tree** — do not mix commits.
