# UI refactor + rebrand — implementation plan (handoff brief)

One milestone with two tracks that land together:

1. **Rebrand + theme**: adopt the new green FlowLink identity (provided SVGs and
   the design reference `FlowLink(4).html`), replacing the current blue/Bosch
   branding end to end — CSS tokens, header logo, nav text, app icon (window,
   favicon, packaged exe).
2. **Markup refactor**: move statically-definable UI out of JavaScript template
   literals into `renderer/index.html`, using the `<template>` pattern the
   codebase already has (`recordingLayoutTemplate`), so JS fills data instead of
   authoring structure.

The implementer needs only this file and the repository.

## 0. Provided files and current state

Provided by the user (copy into the repo, see §2.1):

- `Flowlink app 图标.svg` — 160×160 app icon (rounded square, white bg, green
  `#00884A` F-mark with gradient to `#002213`).
- `FlowLink. logo.svg` — 437×82 wordmark (F-mark + "FlowLink"; green accents,
  black "low" text).
- `FlowLink(4).html` — the design reference: a static mockup of the whole app
  with the new theme. Structure: `<style>` block at L7–1016 (~1 000 lines CSS,
  two layers: base tokens L8–72 then "component values" overrides L74–121),
  static body markup from L1017, demo `<script>` at L1110 (ignore the script —
  it only powers mockup demo content, including a large embedded base64 font).
  Its element ids match the live app (`designPanel`, `drawer`,
  `assistantChat`, `captureSurface`, `aiToggle`, …) because both were built from
  the same design system — treat it as the target for markup and theme, NOT as
  runnable code.

Current state (anchors):

| Area | Today |
|---|---|
| Theme tokens | `renderer/app.css` has three token blocks: `:root` L1 (`--blue:#007bc0`, `--hover:#00629a`, `--pressed:#004975`, `--line`, `--query-line`, `--secondary`, `--placeholder`, `--surface`, `--nav`, …), `:root` L5476 (spacing), `:root` L6058 (`--action-primary:#007bc0`, `--action-hover`, `--action-pressed`, `--action-secondary-hover:#d1e4ff`, `--action-secondary-pressed:#9dc9ff`, disabled/text tokens). **93 hardcoded occurrences** of the blue family (`007bc0|00629a|004975|d1e4ff|9dc9ff`) outside the tokens. |
| Branding | `renderer/index.html` L14 nav-brand and L77 web-brand say **"Taskflow"**; L78 `.bosch-logo` holds a hardcoded red Bosch SVG. `<title>FlowLink</title>` (L6). No favicon. `src/main.ts` `createWindow()` L546 sets **no `icon`** — default Electron icon. `package.mjs` / packager script has no `--icon`. |
| Static shell | `index.html` (897 lines) already owns: nav rail, header, main-page `.flows` table shell + `<tbody id="flowRows">` (L258–277), drawer `#drawer` (L422+) with `#versionManagementRows` (L546), the recording workspace via `<template id="recordingLayoutTemplate">` (L645–847) cloned per flow by `ensureRecordingLayout()` (`app.js` L806, incl. the id-renaming scheme for inactive clones), AI pane, dialogs. |
| JS-generated | `renderer/app.js` (4 896 lines): row lists — `versionManagementRows` L117, `flowRows` L183, `recordingItems` L1049; panels — `analysisResultMarkup(active)` L646 (Process/Reference/Metric/Test result content, the single biggest generated chunk); AI pane — `assistantSteps` L2155 (incl. the fully static option strings `aiOptionsMarkup` L1966 and group-options markup L1978), `assistantChat` L2221, `mentionPicker` L2256; chrome — `updateBrowserChrome` L903 (page tabs), `buildProcessTabGroups` L2881 / `buildTabGroupsForItem` L2923; `renderer/bridge.js` — `buildGroupsFromSteps` L1159. |

Heads-up: the working tree already contains **uncommitted** FlowForge-gaps and
AI-refinement work (`classify.ts`, `systems.ts`, mention picker, …). Build on
top; do not revert or entangle.

## 1. Track A — theme + branding

### 1.1 Token migration (values only; keep token names — the mockup does the same)

Replace values in all three `:root` blocks and sweep the 93 hardcoded sites:

| Token / usage | Old (blue) | New (green) |
|---|---|---|
| `--blue` / `--action-primary` / focus outline | `#007bc0` | `#00884A` |
| `--hover` / `--action-hover` | `#00629a` | `#006A3A` |
| `--pressed` / `--action-pressed` | `#004975` | `#00532D` |
| `--action-secondary-hover` | `#d1e4ff` | `#D1EBDD` |
| `--action-secondary-pressed` | `#9dc9ff` | `#A4D9BD` |
| Secondary-button hover override (mockup L91) | — | `#EDF8F1` bg, `#006A3A` border+text |
| Focus ring (mockup L10) | `#00884A` replaces any blue outline | `outline:1px solid #00884A` |
| Current-row / selected surfaces | blue tints | `#E4F4EB` (recording row current), `#D1EBDD`-family |
| Nav current hover (mockup L102) | — | `#007741` / `#00884A` |
| Disabled | `#f1f3f5 / #dee2e6 / #adb5bd` | keep (unchanged) |

Neutral tokens (`--line:#D7DEE7`, `--query-line:#979EA4`, `--secondary`,
`--placeholder`, `--surface:#EFF1F2`, `--nav:#2E3033`) are unchanged.

Method: port the mockup's two CSS layers in order (base L8–72, then component
overrides L74–121) into `app.css`'s corresponding sections, then
`grep -n "007bc0\|00629a\|004975\|d1e4ff\|9dc9ff" renderer/app.css` must return
**zero** hits. Where the live stylesheet has extra components the mockup lacks
(AI pane, capture surface, test shell — live `app.css` L3318+ design tokens,
L4263+ assistant tokens), apply the same value mapping to their blue-family
hardcodes (`--design-icon-color` etc. keep neutral values; any `--blue`-derived
value becomes the green counterpart).

Font: the mockup uses `"Bosch Sans Global","Open Sans"`, same stack the app
already declares. Do NOT embed the mockup's base64 font (it is demo payload).
If a licensed `BoschSans` woff2 is available later, add it under
`renderer/assets/fonts/` — out of scope here.

### 1.2 Branding

1. **Assets directory**: create `renderer/assets/`; copy the provided SVGs as
   `renderer/assets/logo.svg` (wordmark) and `renderer/assets/icon.svg` (app
   icon). Reference them by relative path (`assets/logo.svg`) — the renderer
   loads over `file://`, so plain relative URLs work.
2. **Header** (`index.html` L76–…): replace the inline `.bosch-logo` Bosch SVG
   with `assets/logo.svg` (via `<img>` or inline SVG; inline keeps currentColor
   theming but the wordmark is multicolor — use `<img>` with explicit width
   ~140px, `alt="FlowLink"`). Adapt the logo slot's aspect-ratio to 437/82
   (mockup uses `--header-logo-height`; simplest: `.bosch-logo img{height:28px;
   width:auto}` and rename the class to `.app-logo` — update the one CSS rule
   and the L78 markup together). Change `.nav-brand` and `.web-brand` text from
   "Taskflow" to "FlowLink"; change drawer demo title if it still says
   Taskflow.
3. **Favicon**: add `<link rel="icon" href="assets/icon.svg" />` to
   `index.html` `<head>` (Chromium supports SVG favicons).
4. **Window icon** (`src/main.ts` `createWindow()` L546): add
   `icon: join(app.getAppPath(), 'resources', 'icon.ico')`. Generate the
   `.ico` once from `icon.svg` at sizes 16/24/32/48/64/128/256 (any converter —
   e.g. ImageMagick or a one-off `sharp` script — then **commit the binary**;
   do not add a build-time dependency for this). Also commit
   `resources/icon.png` (256×256) as fallback.
5. **Packaging**: `package.json` `package` script uses `electron-packager …` —
   add `--icon resources/icon.ico` so the exe gets the icon;
   `package.mjs` already validates files; extend its checklist with
   `resources/icon.ico` if it enumerates resources. Keep
   `renderer/assets/` packaging-safe (packager copies the app dir; nothing to
   do beyond not excluding it).
6. Mockup structure ports (do during M3, listed here for theme completeness):
   query-field divider line, `.tab[aria-selected]` underline in green,
   secondary-button hover override, pagination current-page dot — all already
   covered by the CSS port in 1.1.

## 2. Track B — markup refactor

### 2.1 Rules (behavior-preserving, contract-preserving)

- **Static structure** (anything that does not vary per data item) belongs in
  `index.html` — either directly in the page, or inside
  `<template id="recordingLayoutTemplate">` when it is part of the per-flow
  cloned workspace.
- **Repeated per-item markup** becomes a `<template id="…RowTemplate">` in
  `index.html`; JS clones `content.firstElementChild` and fills slots by
  `data-*` hooks. This is the established pattern — copy `ensureRecordingLayout`
  (L806) semantics.
- JS must stop authoring structural HTML strings; what remains in JS is slot
  filling, `hidden` toggles, and text binding. Escape user data with the
  existing `escapeHTML`.
- **Never rename ids or `data-*` hooks** that `app.js`/`bridge.js` query
  ($ helpers, `querySelector` contracts, IPC-bound controls). The mockup's ids
  match the live app — where they differ, the live app wins.
- New elements added inside `recordingLayoutTemplate` are automatically covered
  by the inactive-clone id-renaming scheme (`data-workspace-id` suffixing,
  L817–833); ids added there must not be queried globally before the layout is
  cloned.

### 2.2 Inventory — what moves where

| Current JS (anchor) | Moves to | JS keeps |
|---|---|---|
| `flowRows` rows (`app.js` L183) | `<template id="flowRowTemplate">` (row `<tr>` with checkbox, name link, description, version, action icon-buttons as static markup) | clone per task, fill name/code/description/version, set `data-*` ids, disabled states |
| `versionManagementRows` (L117) | `<template id="versionRowTemplate">` | same |
| `recordingItems` rows (L1049) | `<template id="recordingItemRowTemplate">` (checkbox, name button, badge span, delete icon-button) | clone per item; toggle `.current`, badges, disabled |
| `analysisResultMarkup(active)` (L646) — Process/Reference/Metric panel shells | static sections inside `recordingLayoutTemplate` / sibling templates, one per tab, shown/hidden by `resultPanel` class wiring that `renderSummaryWorkspace` (L1651) already manages | fill step lists, group cards, reference rows, metric values |
| `aiOptionsMarkup` (L1966), group-options markup (L1978), test toolbar markup (L1968) | static markup in the AI pane section of `recordingLayoutTemplate`, mutually exclusive via `hidden` | `renderAIPanel` only toggles which block is visible and binds handlers |
| `assistantChat` messages (L2221) | `<template id="assistantMessageTemplate">` (`<p class="assistant-message {role}">` + attachment chip span) | clone per message; chips filled from `message.attachments` |
| `mentionPicker` options (L2256) | `<template id="mentionOptionTemplate">` | clone per recording option |
| `updateBrowserChrome` page tabs (L903) | `<template id="browserTabTemplate">` (inside the layout template) | clone per tab; active/close state |
| `buildProcessTabGroups` / `buildTabGroupsForItem` (L2881/L2923) group cards | `<template id="processGroupCardTemplate">` | clone per group; count/label/tab/url |
| `bridge.js` `buildGroupsFromSteps` (L1159) | reuse `processGroupCardTemplate` if reachable, else its own template | same |
| Mockup structural deltas (query fields with divider, content toolbar, pagination row, footer, drawer form field styling) | port into `index.html` main-page/drawer sections during M3, reconciling with live ids | — |

Do NOT attempt to move: dynamically interleaved things that genuinely vary in
structure (chat text, step captions, test step rows with status icons may stay
template-cloned with status class toggles; if a piece is cheaper left as text,
leave it — the goal is shells and rows, not 100 % purity).

### 2.3 Suggested commit slicing

- **M1 Theme + assets** (CSS tokens + sweep, assets dir, header/nav rebrand,
  favicon, window icon, packager icon). No JS logic changes; `app.js` untouched
  except none. Immediately visible, easiest to review as a diff of colors.
- **M2 Row templates** (flowRows, versionManagementRows, recordingItems,
  assistant messages, mention options, browser tabs, process group cards).
  Mechanical; verify by manual pass.
- **M3 Panel shells** (analysisResultMarkup decomposition, AI pane static
  blocks, mockup structural ports for main page/drawer). The largest change;
  do per tab (Process first, then Reference, Metric, Test) so each stays
  reviewable.
- **M4 Packaging + docs** (exe icon verification on a packaged build, README /
  README-zh screenshots if any reference the old look, `CHANGELOG.md` per
  `docs/changelog-guide.md`, `docs/technical-architecture.md` §"Source map"
  renderer row note that index.html now owns static shells).

## 3. Validation

Per milestone and at the end:

```powershell
npm run build
npx tsc --noEmit
npm test
node --check renderer/app.js
node --check renderer/bridge.js
```

- `grep -n "007bc0\|00629a\|004975\|d1e4ff\|9dc9ff" renderer/app.css` → 0 hits
  after M1; `grep -c "Taskflow\|ED0007" renderer/index.html` → 0 hits.
- Manual UI pass (AGENTS.md scenarios + this refactor's own): main page renders
  flows table with green theme; create/open taskflow drawer (form, version
  rows); record one navigation/click/input and stop (recording list rows,
  browser toolbar tabs, capture surface border in green); analysis drawer —
  Process groups, Reference list, Metric, Test run; AI pane open, options
  block, one advice message, @ mention picker.
- After M2/M3 specifically: browser surface bounds still track the layout
  (the renderer reports the DOM rectangle to the main process — a layout
  refactor can shift it; resize the window and confirm the embedded view
  follows, dialogs still hide it).
- After M4: package once and confirm `FlowLink.exe` shows the new icon and the
  app launches (AGENTS.md: packaging checks whenever packaging scripts or
  Electron resources change).

## 4. Risks and traps

1. **Mockup is a demo, not the app**: its script block (L1110+), demo rows,
   embedded base64 font, and any id that does not exist in the live app must
   not be copied. Port markup/CSS selectively, always reconciling with live
   id contracts.
2. **93 hardcoded blues**: some live components (AI pane, test shell) have no
   mockup counterpart; map their blues by role (primary action → #00884A,
   hover → #006A3A, pressed → #00532D, tint → #D1EBDD/#EDF8F1). Keep neutrals.
3. **Template id-renaming scheme**: anything with an `id` added inside
   `recordingLayoutTemplate` gets suffixed in inactive per-flow clones
   (`app.js` L817–833). Global `$(id)` lookups for template-internal elements
   are only valid for the ACTIVE clone — use `layout.querySelector` in JS the
   way existing code does.
4. **Icon generation**: `.ico` must be multi-size; a single 256px png renamed
   to `.ico` renders blurry at taskbar sizes. Commit the real multi-size file.
5. **Bounds reporting** (§3) — the embedded browser is a native view positioned
   from a DOM rectangle; structural moves in the workspace are the one place
   this refactor can break runtime behavior while looking fine in static
   review.
6. **Uncommitted prior work in the tree** (FlowForge gaps, AI refinement M3) —
   sequence commits so the UI refactor does not mix with it.
7. **CSS layer order matters**: the mockup's second layer (L74–121) overrides
   the first; porting both as separate sections in the same order preserves
   the intended final values.
