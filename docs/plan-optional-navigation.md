# Config-free optional navigation — implementation plan (handoff brief)

Self-contained plan for replacing the configurable classification file with
automatic detection + replay-tolerant **optional navigation steps**. The
implementer needs no other context than this file and the repository.

Design intent (decided with the user):

- FlowLink is AI-oriented: **no hand-maintained config file** for SSO sites.
- Detection stays automatic (built-in URL-shape defaults + Electron
  `will-redirect` host events — both zero-maintenance, both already implemented).
- Treatment changes: detected auth redirects are no longer *dropped* from the
  executable Flow. They become `navigate` steps flagged `isOptional: true`, and
  **replay decides**: wait briefly; if the browser has already moved past the
  recorded pre-redirect URL, the redirect happened by itself → skip the step;
  otherwise execute it. This degrades gracefully when record-time and
  replay-time auth state differ, instead of failing or silently losing hops.

## 0. Ground rules

- Follow `AGENTS.md` invariants (immutable `observed` evidence, Zod on every
  Flow write, no Node/Electron APIs in the renderer, sanitize generated path
  segments, never log secrets).
- Baseline checks after each workstream:

  ```powershell
  npm run build
  npx tsc --noEmit
  npm test
  ```

- The working tree contains **uncommitted** work: the FlowForge-gaps
  implementation (4A/4B/4C, the baseline this plan modifies) *and* a separate
  AI-refinement feature (`src/ai-refine.ts`, renderer changes, extra tests).
  Do not commit, revert, or entangle them; keep this change on top.
- Line numbers below have drifted; named functions/exports are the anchors.

## 1. Current behavior (what changes)

Implemented earlier in this tree (workstreams 4A/4B):

1. `engine/recorder/src/classify.ts` — `compileAuthMatchers(config?)`,
   `isAuthUrl`, `SUPPRESSED_NAVIGATION_TYPES` = {`sso_redirect`,
   `login_redirect`, `auto_redirect`}.
2. `record.ts` `framenavigated` listener enqueues **every** main-frame
   navigation with its `navigationType`; `processBatch` filters
   `SUPPRESSED_NAVIGATION_TYPES` events out of the coalescer input (they never
   merge into a previous action's `expectUrl` — the reason the filter exists)
   and they produce no steps.
3. `src/main.ts` reads `config/classification.json` (zod-validated) and passes
   `classification` + `systemAliases` into `recordOnPage`, and
   `{ matchers, aliases }` into `writeFlowForgeArchive`.
4. `systems.ts` `resolveSystem(url, aliases?)` + alias-collapsing `systems[]`
   aggregation in the sidecar.

What this plan changes:

- (2) → filtered events become **optional navigate steps** instead of nothing.
- (3) → the config file, its reader, and all app-side threading are **removed**.
- `isOptional` is added to the schema and honored by the executor.
- (4) stays as engine capability; the app passes no aliases (nothing to keep
  `RecordOptions.systemAliases`? — see §5 decision).

## 2. Workstream A — schema: `isOptional`

- `engine/schema/src/schema.ts`, `BaseStepSchema` (~L138): add
  `isOptional: z.boolean().optional()`. Additive optional field → old flows
  parse unchanged, **no schemaVersion bump, no migration** (per AGENTS.md
  backward-compat rule).
- `validateFlowContract`: no new rule in v1 (the recorder only sets it on
  `navigate` steps; do not restrict yet — later step kinds may use it).
- Document in the schema comment: *semantics — replay may skip this step when
  its effect has already occurred; set by the recorder for machine-initiated
  auth redirects.*

## 3. Workstream B — recorder: emit optional navigations

1. **classify.ts**: rename `SUPPRESSED_NAVIGATION_TYPES` →
   `AUTO_NAVIGATION_TYPES` and update its comment (these types are no longer
   suppressed from the Flow; they are emitted as optional steps). Update the
   two references (`record.ts`, tests). No other behavior change.
2. **plan.ts** (pure planning module — new export):
   `synthesizeOptionalNavigations(events: RawEvent[]): CoalescedAction[]` —
   for each navigation event whose `navigationType` is in
   `AUTO_NAVIGATION_TYPES`, produce
   `{ kind: 'navigate', ts, pageIndex, frameIndex, frameUrl, url, previousUrl,
   navigationType, navigationEvidence, directNavigation: true, merged: 1,
   raw: [event] }`. `directNavigation: true` is deliberate: these actions are
   never fed back into `coalesceEvents`, and the flag documents that each is a
   standalone step, not an expectation of a previous action.
3. **record.ts `processBatch`** (anchor: the `pageEvents` filter with the
   `AUTO_NAVIGATION_TYPES` comment): split the batch —

   ```ts
   const autoNavigations: RawEvent[] = []
   const pageEvents = batch.filter((event) => {
     if (event.kind === 'navigation' && AUTO_NAVIGATION_TYPES.has(event.navigationType ?? '')) {
       autoNavigations.push(event)
       return false
     }
     …existing explicit-navigation dedup…
   })
   ```

   then append
   `plan.synthesizeOptionalNavigations(autoNavigations)` to `orderedActions`
   (it already sorts by `ts` together with `explicitNavigationActions`).
   **The filter must stay before `coalesceEvents`** — that is the `expectUrl`
   merge trap from the previous plan; only the destination of the filtered
   events changes (steps instead of the void).
4. **record.ts `buildStep`** `case 'navigate'`: when
   `AUTO_NAVIGATION_TYPES.has(action.navigationType ?? '')`, add
   `isOptional: true` to the returned step.
5. **Expect inference**: skip `takeExpect` and the `expectUrl` fallback for
   optional navigations (same guard style as the existing `drag` guard —
   machine redirects must not fabricate urlChange expectations). Keep the
   generic download logic untouched.
6. **`refineSteps`** (currently private at the bottom of `record.ts`): move it
   to `plan.ts` unchanged and export it (it is a pure function; `plan.ts` is
   already bundled in the test suite). Add one guard to the openTab-merge
   branch: a `navigate` step with `isOptional` must **not** be merged into the
   preceding `openTab` URL (it would silently lose the flag and the replay
   decision). Update `record.ts` to import it.
7. Evidence side effect (no code needed): optional nav events now sit in
   `action.raw`, so they gain `flowStepId` + before/after snapshot links —
   strictly better than the current unannotated evidence.

## 4. Workstream C — executor: replay semantics for optional navigations

1. **Pure helper** (put beside `bestEffortNetworkIdle` in
   `engine/executor/src/actions.ts`, exported for tests):
   `sameSitePath(a: string, b: string): boolean` — parse both URLs; equal iff
   `origin + pathname` match. Ignore query and hash entirely (SSO round-trips
   carry per-run `state`/nonce params; hash is unreliable for SPA routing —
   known limitation, document it). Unparseable input → `false`.
2. **Constant**: `OPTIONAL_NAV_WAIT_MS = 800` (exported from `actions.ts`).
3. **`engine/executor/src/run.ts`** step loop — anchor: right after the
   `browserCrashed` skip block, before the step dispatch:

   ```ts
   if (item.step.kind === 'navigate' && item.step.isOptional) {
     await sleep(OPTIONAL_NAV_WAIT_MS)   // 给自动重定向留出发生的时间
     const expected = item.step.previousUrl
     const current = page.url()
     if (expected && !sameSitePath(current, expected)) {
       // 重定向已自行发生（可能已串到链上更后面的 URL）→ 跳过本步
       // 复用现有 status: 'skip'（与中止/崩溃跳过同形），detail 带说明性 log，
       // steps/details/onStep 照常上报，continue。
     }
     // 否则（含 previousUrl 缺失的保守回退）正常执行 goto。
   }
   ```

   - `status: 'skip'` already exists in the report model (used by abort and
     browser-crash paths); `passCount`/`failCount` treat it as neither.
   - Log both branches into the step log (`可选导航：浏览器已在 X，跳过` /
     `可选导航：仍在 Y，执行导航`).
   - The 0.8 s wait does not watch `abortSignal`; worst case it delays abort
     handling by 0.8 s — acceptable, note it in a comment.
   - Verify the renderer renders `status: 'skip'` steps acceptably (it already
     receives them from abort paths); adjust only if it crashes.

## 5. Workstream D — remove the manual config

1. **`src/main.ts`**: delete `RecordingClassification`, `EMPTY_CLASSIFICATION`,
   `ClassificationFileSchema`, `classificationConfigPath`,
   `loadRecordingClassification`, the `recordingClassification` state var and
   its reset in `resetRecordingState`. `recordOnPage` loses
   `classification`/`systemAliases`; `writeFlowForgeArchive` loses the options
   argument; `captureTabs` uses `resolveSystem(url)` with no aliases. Remove
   the now-unused `compileAuthMatchers` import (keep `resolveSystem`).
   Remove the `zod` import if nothing else in `main.ts` uses it (the
   AI-refinement work may use it — check before deleting).
2. **Delete `config/classification.json` example**: remove
   `config/classification.example.json`.
3. **`engine/recorder/src/types.ts`**: remove `classification` from
   `RecordOptions` (and the now-unused `ClassificationConfig` import). **Keep
   `systemAliases?`** — decision: engine-level API only (programmatic callers
   and tests; the app passes nothing). `resolveSystem`'s alias parameter,
   `writeFlowForgeArchive`'s `{ matchers, aliases }` options, and
  `compileAuthMatchers(config?)` all stay — they are library surface, not
   user-maintained configuration.
4. `classify.ts` module doc: update the sentence about "two historical inline
   implementations sharing config" — record time and archive time now both use
   compiled-in defaults in the app path; the shared-matcher requirement stands
   for programmatic callers.

## 6. Sequencing

One change, in this order (each step keeps the tree green):

1. A (schema) — additive, everything still passes.
2. C (executor) — honors `isOptional` before any flow contains it.
3. B (recorder emission) — flows start carrying optional steps.
4. D (config removal) — app-side cleanup.
5. Tests + docs.

## 7. Tests (`tests/flow-authoring.test.mjs`, same esbuild-bundle style)

- Update `'suppressed auth redirects must be filtered before coalescing…'`:
  the filter still keeps the coalescer input clean (click keeps no
  `expectUrl`), **and** `synthesizeOptionalNavigations` turns the filtered
  event into one `navigate` action with the event in `raw` and
  `directNavigation: true`.
- New: `refineSteps` (now in `plan.ts`) — an `isOptional` navigate directly
  after `openTab` stays a separate step; a plain navigate after `openTab`
  still merges (regression).
- New: `sameSitePath` (bundle `actions.ts` or extract the helper into a tiny
  pure module if `actions.ts` drags too much into the bundle) — equal
  origin+path with different query/hash → `true`; different path → `false`;
  unparseable → `false`.
- Schema: a `navigate` step with `isOptional: true` parses; the existing
  flows-without-it tests already cover the old shape.
- Executor end-to-end (optional skip vs execute) is **not** unit-testable in
  this suite (needs a live Page) — covered by the manual scenario below.
- Keep the existing alias-collapsing archive test (engine API unchanged).

## 8. Validation checklist

- `npm run build`, `npx tsc --noEmit`, `npm test`.
- Manual scenario 1 (redirect happens at replay): with **no** stored login
  state, record a flow that passes through an SSO redirect; stop. The Flow
  contains the redirect as an `isOptional` navigate step; the sidecar retains
  the raw events. Replay logged-out: the site redirects by itself → the step
  reports `skip`, replay continues and passes.
- Manual scenario 2 (redirect does not happen): replay the same flow **with**
  authenticated storage state: the browser stays on the pre-redirect URL →
  the optional step executes `goto` and the flow passes.
- Baseline recording scenario (start URL, one click, one input, stop, load)
  must be unchanged except for optional steps appearing where redirects
  occurred.
- Docs to update: `docs/architecture.md` (recording pipeline point 9 + the
  classification paragraph), `docs/technical-architecture.md` (§2 source map
  row for classify.ts, §8 recording paragraphs), `CHANGELOG.md` (**rewrite**
  the two bullets that advertise `config/classification.json` — they describe
  a mechanism this plan removes; keep the drag bullet), `README.md` /
  `README-zh.md` (replace the config-file feature bullet with optional
  navigation).

## 9. Risks and traps

1. **The `expectUrl` merge trap still applies**: optional navigations must
   stay out of `coalesceEvents`' input. Synthesis happens **after** the
   `pageEvents` filter, exactly like `explicitNavigationActions`. Feeding the
   filtered events into the coalescer would rewrite every click's expectation.
2. **`refineSteps` openTab merge** would silently strip `isOptional` — the
   guard in §3.6 is mandatory, with a regression test.
3. **URL comparison**: exact-URL matching misfires on per-run SSO query
   params; `sameSitePath` compares origin+pathname only. Hash-routed SPAs are
   a documented limitation.
4. **Redirect chains** (A→B→C): each hop becomes its own optional step; at
   replay each adds up to 0.8 s of waiting. Acceptable; the constant is
   tunable. Chains whose hops land in different flush batches still emit one
   optional step per recorded navigation event (no pairing needed here —
   unlike drags, each navigation is independently well-formed).
5. **Record/archive divergence**: the archive may re-classify a navigation via
   host `autoRedirect` events to a different type than record time decided.
   The executable step keeps its record-time classification; only sidecar
   evidence differs. Acceptable — the sidecar is evidence, the Flow is replay
   authority.
6. **Uncommitted tree**: AI-refinement work shares `src/main.ts` and the test
   file. Keep edits surgical; do not commit unless asked.
