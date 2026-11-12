# FlowForge known gaps — implementation plan (handoff brief)

Self-contained plan for closing the three gaps listed in `docs/FLOWFORGE_MERGE.md` §6.
The implementer needs no other context than this file and the repository.

## 0. Ground rules

- Follow `AGENTS.md` invariants: `observed` facts are immutable record-time evidence; every Flow write passes Zod parsing; no Node/Electron APIs in the renderer; sanitize generated IDs/path segments; never log cookies, passwords, storage state, or secret variables.
- Baseline checks that must pass at the end of each workstream:

  ```powershell
  npm run build
  npx tsc --noEmit
  npm test
  ```

- The working tree already contains ~1,150 lines of **uncommitted** feature work (schema v2 conditions, host events, Process editor). Do not commit, revert, or mix it with this work; keep these changes separate.
- Engine packages stay pure: new configuration is read by `src/main.ts` and passed into the recorder via `RecordOptions`. Engines never read files or `app.*`.
- Line numbers below are accurate at the time of writing; if they drifted, the named function/regex is the anchor.

## 1. Workstream 4A — configurable navigation/SSO classification

### Current behavior (what to change)

1. `engine/recorder/src/record.ts` ~L444–510, inside the page `framenavigated` listener:
   an inline closure `authUrl(url)` classifies auth URLs with two **hardcoded** regexes:
   hostname `/(^|\.)(login|logon|auth|sso|signin|identity|idp)(\.|$)/i` and
   pathname `/\/(login|logon|oauth|authorize|saml|signin|sso)([/?#]|$)/i`.
2. `record.ts` ~L510: navigations classified `sso_redirect` / `login_redirect` /
   `auto_redirect` are **not enqueued at all** — they vanish from the raw evidence
   stream, so they are absent from the FlowForge sidecar too. An over-broad
   pattern would silently erase evidence.
3. `engine/recorder/src/flowforge-archive.ts` L141: a **second hardcoded copy** of
   the same auth regex (`isAuth`), used when host `autoRedirect` events are
   re-classified during archive writing.

### Tasks

- **A1. New pure module** `engine/recorder/src/classify.ts`:
  - `export const DEFAULT_IDP_HOST_PATTERN` / `DEFAULT_LOGIN_PATH_PATTERN` (the two regexes above, as strings).
  - `compileAuthMatchers(config?: { idpHostPatterns?: string[]; loginPathPatterns?: string[] })` →
    `{ host: RegExp[]; path: RegExp[]; warnings: string[] }`. Custom patterns are
    OR'd with the defaults; entries that fail `new RegExp(...)` are skipped and
    reported in `warnings` (never throw — a bad config must not break recording).
  - `isAuthUrl(url: string, matchers): boolean` — parses the URL, tests hostname
    against `host` and pathname against `path`; unparseable URLs return `false`.
- **A2. `RecordOptions`** (`engine/recorder/src/types.ts`): add
  `classification?: { idpHostPatterns?: string[]; loginPathPatterns?: string[] }`.
  Compile once at the top of `record()`; push `warnings` into the recording's
  `warnings` array; replace both inline uses of the closure regex.
- **A3. Evidence-retention fix** (behavior change, deliberate):
  - In the `framenavigated` listener, **enqueue every main-frame navigation**
    (keep `navigationType`, `navigationEvidence`, `directNavigation` as computed today).
  - In `processBatch` (~L1075, where `pageEvents` is filtered), additionally drop
    events whose `navigationType` is `sso_redirect`, `login_redirect`, or
    `auto_redirect` **before** `coalesceEvents` runs.
  - Why the filter must live in `processBatch`: `coalesce.ts` L233–258 merges any
    non-direct navigation that follows an action within `bufferMs` into the previous
    action's `expectUrl`. Today auth redirects never reach the coalescer, so simply
    enqueuing them would silently change every recorded click's expectation. The
    filter set must exactly match today's suppression set.
  - Net effect: executable Flow output is byte-for-byte unchanged; the raw
    evidence stream and the sidecar now retain auth redirects.
- **A4. Archive consistency**: `writeFlowForgeArchive`
  (`flowforge-archive.ts` L130) gains the compiled matchers (extend its options —
  see signature note in 4B) and replaces the local `isAuth` at L141 with
  `isAuthUrl`. Record-time and archive-time classification must use the same
  configuration or the Flow and the sidecar will disagree.
- **A5. Host config** (`src/main.ts`):
  - Resolve the file like the Pi credential file (`src/pi-agent.ts` L51–65 for the
    pattern): `config/classification.json` under `app.getAppPath()` in dev, under
    `app.getPath('userData')` when `app.isPackaged`.
  - Validate the shape (`idpHostPatterns: string[]`, `loginPathPatterns: string[]`,
    `systemAliases: Record<string,string>`) — zod is already a dependency. Missing
    file → empty config. Invalid file → log a warning, fall back to empty config;
    never block recording startup.
  - Pass `classification` into the `recordOnPage(...)` call (~L920–950) and the
    matchers into `writeFlowForgeArchive(...)` at the stop path.
- **A6. Example config**: add `config/classification.example.json` with the three
  keys and a short comment-style README pointer.

### Tests (extend `tests/flow-authoring.test.mjs`, same esbuild-bundle style)

- `compileAuthMatchers`: custom pattern matches URL the defaults miss; invalid
  regex skipped and warned; defaults still applied when config is empty.
- `isAuthUrl`: host match, path match, neither, unparseable input.
- Recorder-level (if practical without Electron): a `sso_redirect` navigation raw
  event is retained in the raw list but produces no `navigate` action — the
  processBatch filter logic can be exercised by exporting it or by testing
  `coalesceEvents` with the filter applied.

### Acceptance

- With no config file: recording output identical to today (defaults).
- With a custom IdP pattern matching a test redirect: the redirect is omitted
  from Flow steps but present in `flowforge-recording.json` `events[]` with its
  `navigationType`.

## 2. Workstream 4B — system alias map

### Current behavior

System identity is derived from bare hostnames in **three independent places**:

1. `flowforge-archive.ts` L24 `systemFromUrl()` (used by `safeEvent` L38, host-event
   projection L152, and the `systems[]` aggregation L157–160).
2. `record.ts` L234–236 — step enrichment (note: non-http URLs → `browser`/`Browser`).
3. `record.ts` L334–337 — event enrichment (`browser` fallback on parse failure).

The `systems[]` aggregation (L157–160) dedupes by `tab.systemId` but takes
`domains` from a single tab's URL, so one logical system on N hostnames currently
appears as N systems.

### Tasks

- **B1. New module** `engine/recorder/src/systems.ts`:
  - `resolveSystem(url: string, aliases?: Record<string, string>): { systemId: string; systemName: string; domain?: string }`.
  - Exact, case-insensitive hostname match against `aliases` first. A hit returns
    `{ systemId: slug(aliasName), systemName: aliasName, domain: hostname }` where
    `slug` is the existing `[^a-z0-9]+ → '-'` transform.
  - Miss → today's behavior exactly (hostname slug + hostname name).
  - Non-http/`about:` URLs → `browser`/`Browser`; parse failure →
    `unknown-system`/`Unknown system`. Preserve these special cases — they differ
    subtly between the three current call sites (see risk 6).
- **B2.** Add `systemAliases?: Record<string, string>` to `RecordOptions`; thread
  through `record()` and replace call sites 2 and 3.
- **B3.** `flowforge-archive.ts`: replace all three `systemFromUrl` uses with
  `resolveSystem(url, aliases)`. `writeFlowForgeArchive` currently takes
  positional params `(rawPath, flow, tabs, outputDir, hostEvents)` — extend with a
  final optional options object `{ matchers?, aliases? }` rather than growing the
  positional list, and update its caller in `src/main.ts`.
- **B4.** Rebuild the `systems[]` aggregation so aliased hosts collapse: group by
  `systemId`, merge `domains` from all contributing tabs, keep one entry per
  system. Unaliased hosts keep today's one-entry-per-hostname shape.
- **B5.** `src/main.ts` reads `systemAliases` from the same `classification.json`
  and passes it to both `recordOnPage` and `writeFlowForgeArchive`.

### Tests

- `resolveSystem`: alias hit (case-insensitive), alias miss falls back, slug of
  alias name, non-http → `browser`, unparseable → `unknown-system`.
- Aggregation: two tabs on `a.corp.example` and `b.corp.example` both aliased to
  `ERP` → one `systems[]` entry `{ systemId: 'erp', name: 'ERP', domains: ['a.corp.example', 'b.corp.example'] }`.

### Acceptance

- With no aliases: sidecar `systems[]` identical to today.
- With aliases: tabs/steps/semantic steps carry the aliased identity;
  `tabs[].systemId` matches the aggregated `systems[]` entry.

## 3. Workstream 4C — drag: from evidence to executable step

### Current state (asymmetry to exploit)

- Page capture emits both events **with element facts**:
  `engine/recorder/capture/capture.js` L549–556 (`dragstart`/`drop` →
  `send('dragStart'|'drop', retarget(el), {}, true)`).
- `coalesce.ts` L42–53 deliberately drops both from executable planning
  (evidence-only), and `RawEventKind` already includes them (`types.ts` L87–88).
- The schema already has `drag` (`schema.ts` L214–218): `from: ElementRef`,
  `to: PointRef` (`{ target?: ElementRef; x?: number; y?: number }`), and contract
  validation already visits both refs.
- The executor already replays it (`actions.ts` L280–316): `to.target` →
  `locator.dragTo`; otherwise x/y mouse fallback.
- `record.ts` builds refs via `buildRefFor(action, stepIndex)` (L632, used at L823
  in the action→step switch).

**Only the recorder is missing.** No schema or executor changes.

### Tasks

- **C1. Types** (`engine/recorder/src/types.ts`): add `'drag'` to
  `CoalescedActionKind`; extend `CoalescedAction` with optional
  `from?: RawElementFacts` / `to?: RawElementFacts` (the common `facts` field
  stays for single-target actions; for `kind: 'drag'`, `from`/`to` are required).
- **C2. Coalescer** (`coalesce.ts`): replace the `dragStart`/`drop` fall-through:
  - `dragStart` with `facts` opens a single pending-drag slot
    `{ facts, ts, raw: [event] }` (one at a time; a new `dragStart` discards the
    previous unpaired one silently).
  - `drop` with `facts` closes the slot into one action when: same `pageIndex`,
    both trusted, and `drop.ts - dragStart.ts <= DRAG_PAIR_MS` (new constant,
    5000). Produce `{ kind: 'drag', ts: drop.ts, from: start.facts, to: drop.facts,
    frameIndex/frameUrl/pageIndex: from drop, merged: 1, raw: [startEvent, dropEvent] }`.
  - Unpaired `drop`, cross-page pair, or expiry (any other action kind arrives, or
    the window passes) → no action; the raw events stay in the evidence stream
    regardless (coalescing never removes raw events).
  - **v1 limitation, document it in code:** `coalesceEvents` is stateless per
    batch, so a drag whose start and drop land in different flush batches (~500 ms
    apart) is not paired and stays evidence-only. Do not thread cross-batch state
    into the coalescer in this change; note it as a follow-up.
- **C3. Planner** (`plan.ts`): `withTabSwitches` already positions actions by
  `pageIndex`; verify `pageIndexOf` handles the drag action (it reads
  `action.pageIndex`) — no change expected.
- **C4. Step planning** (`record.ts` action switch, next to `case 'select'`):
  add `case 'drag'`:
  - `const from = await buildRefFor({ ...action, facts: action.from }, stepIndex)`
  - `const to = await buildRefFor({ ...action, facts: action.to }, stepIndex)`
    (`buildRefFor` reads `facts`; reuse it for both sides rather than duplicating
    collection logic).
  - If **either** ref fails to resolve (no stable UID / element gone): do **not**
    fabricate — skip the step and push a warning
    (`drag …: 目标事实无法复核，仅保留为证据` style, match existing warning tone).
  - On success: `pushStep({ kind: 'drag', id, from, to: { target: toRef } }, action.pageIndex)`
    with the usual `markPage`. No `expect` inference in v1.
- **C5.** No Process-editor work in v1: manual drag steps are already creatable
  in principle (schema + executor exist); the editor's rule that manual element
  actions reference recorded `ElementRef`s covers this once drag steps are recorded.

### Tests

- `coalesceEvents` pairing: happy path (start→drop), window expiry (drop too
  late), orphan `drop`, cross-page non-pairing, second `dragStart` resets the slot,
  intermediate action breaks pairing.
- Recorder-level: a paired drag produces one `drag` step whose `from`/`to` carry
  candidates + fingerprint (mirror how the suite builds `elementRef()` fixtures).

### Acceptance (manual scenario)

- Record an HTML5 drag between two sortable lists → exactly one `drag` step with
  two resolved ElementRefs; replay executes it via `dragTo` and passes.
- `flowforge-recording.json` still contains the `dragStart`/`drop` events
  (evidence invariant unchanged).

## 4. Sequencing

1. **Change 1 = 4A + 4B together** (shared config file, `RecordOptions` plumbing,
   `writeFlowForgeArchive` options object, main.ts reader).
2. **Change 2 = 4C** (recorder-internal, independent of the config work).
3. Optional follow-up (out of scope): regression fixtures for FlowForge
   widget-grouping heuristics in the semantic projection; cross-batch drag
   pairing; wildcard alias patterns.

## 5. Validation checklist (per AGENTS.md)

- `npm run build`, `npx tsc --noEmit`, `npm test`.
- Manual recording scenario: start-URL navigation, one click, one input, stop,
  flow load — must be unchanged.
- 4A/4B scenario: record through a URL matching a configured IdP pattern with two
  hostnames aliased to one system; verify Flow omits the redirect, the sidecar
  retains it, and `systems[]` shows one aggregated entry.
- 4C scenario: the drag record/replay above.
- Docs to update when done: `docs/architecture.md` (recording pipeline section),
  `docs/technical-architecture.md` (§8 recording / §6 layout if the sidecar
  content description changed), `CHANGELOG.md` per `docs/changelog-guide.md`,
  README feature bullets.

## 6. Risks and traps

1. **The `expectUrl` merge trap** (biggest one): `coalesce.ts` L233–258 attaches
   any non-direct navigation within `bufferMs` to the previous action as
   `expectUrl`. 4A's new filtering must happen in `processBatch` **before**
   `coalesceEvents`, with a set exactly equal to today's enqueue-level suppression
   (`sso_redirect`, `login_redirect`, `auto_redirect`), or every recorded click's
   expectation changes.
2. **Two classification sites must share config**: record-time classification and
   the archive's host-event re-classification (`flowforge-archive.ts` L141) both
   classify auth URLs; if only one becomes configurable, the Flow and the sidecar
   diverge for the same recording.
3. **`writeFlowForgeArchive` signature change** has a caller in `src/main.ts`
   (stop path); update both together.
4. **Evidence invariant**: never filter raw events out of the buffer/archive —
   4A only changes what reaches the *executable* planner.
5. **Uncommitted work in the tree**: this plan's changes must not be entangled
   with the in-flight schema-v2/host-events work already present.
6. **`systemFromUrl` special cases differ by call site** (step enrichment maps
   non-http to `browser`; the archive maps parse failures to `unknown-system`).
   Unify deliberately and keep an explicit test for each fallback so no call site
   silently changes identity.
