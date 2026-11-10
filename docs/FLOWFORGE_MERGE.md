# FlowLink + FlowForge recorder merge

**Merge target:** FlowLink UI and Electron application remain the product shell. FlowLink's resolver and executor remain the replay engine. FlowForge 0.4's event/evidence model is integrated as a first-class recording layer and sidecar archive.

## 1. What changed

### Kept from FlowLink

- Existing renderer/UI, task store, Electron `BrowserWindow` + `WebContentsView` browser surface, tab strip and navigation IPC.
- Existing `EngineBridge` / Playwright CDP attachment.
- FlowLink's `@rr/recorder` event coalescing, element fingerprinting, candidate validation, screenshot crops, expected-state inference and Flow IR generation.
- FlowLink's resolver, self-healing and executor. This is deliberately not replaced with FlowForge's separate Playwright workflow engine.

### Ported from FlowForge's recorder/evidence model

- Ordered, cross-tab event stream with stable `eventId`, `sequence`, `tabId`, `pageIndex`, `frameIndex`, timestamp, URL, title and system identity.
- System identity derived from hostname, with per-tab system metadata.
- Additional capture events: `dblclick`, `submit`, `dragStart`, `drop`, `copy`, `paste`, `extractValue`, `focus` and `blur`.
- Clipboard relationship metadata: copy/paste events are linked in semantic steps; clipboard contents are never read or persisted.
- Before/after structured DOM signature snapshots attached to the raw source events.
- Flow step provenance: `tabId`, `systemId`, `systemName`, `pageUrl`, `sourceEventIds`, and `locatorEvidence` are now part of the FlowLink step schema.
- FlowForge-compatible semantic event projection and a validated recording archive sidecar.
- Dynamic page attachment while recording: newly created HTTP(S)/about:blank pages are attached to the recorder; `file://` app-shell pages are excluded.

## 2. Files changed / added

| File | Purpose |
|---|---|
| `engine/recorder/capture/capture.js` | Adds FlowForge-style supplementary DOM event listeners without replacing FlowLink's existing capture facts pipeline. |
| `engine/recorder/src/types.ts` | Extends raw event types and capture provenance fields. |
| `engine/recorder/src/coalesce.ts` | Keeps supplemental evidence events out of executable action coalescing while retaining them in the raw stream. |
| `engine/recorder/src/record.ts` | Assigns event IDs, stable tab/system identity, before/after DOM signatures, locator provenance and dynamic-page capture. |
| `engine/schema/src/schema.ts` | Extends executable step schema with FlowForge provenance metadata. |
| `engine/recorder/src/flowforge-capture-schema.ts` | Zod 3 schema for the FlowForge-compatible event/archive contract. |
| `engine/recorder/src/flowforge-archive.ts` | Converts FlowLink raw capture + Electron tab events into `flowforge.recording.v1`. |
| `engine/recorder/src/index.ts` | Exports archive writer and capture schema. |
| `src/main.ts` | Supplies native tab IDs, enables raw evidence retention and writes the sidecar at stop. |

## 3. Recording output structure

Each successful recording now has two complementary outputs:

1. **FlowLink executable Flow JSON** — authoritative input to the existing replay resolver/executor. It retains the actual input values required for replay according to existing FlowLink privacy behavior, plus locator fingerprints, candidates, page mapping and expected state.
2. **`artifacts/<flow-id>/record/flowforge-recording.json`** — immutable capture evidence and semantic projection. Its top-level schema is `flowforge.recording.v1` and it contains:
   - `tabs[]` and `systems[]`
   - globally ordered `events[]`
   - `target` facts and `locatorEvidence`
   - `beforeSnapshot` / `afterSnapshot` structured DOM signatures where available
   - `flowStepId` linking an event back to an executable step
   - `semanticSteps[]`, including cross-system clipboard source relationships
   - warnings and source metadata

The sidecar is validated against `FlowForgeRecordingSchema` before it is written. The FlowLink Flow IR remains the source of truth for replay; the sidecar is not silently treated as an executable workflow.

## 4. How replay information is improved

A recorded action now carries several independent kinds of evidence:

- **Identity:** role, accessible name, labels, text, attributes, nearby text, node path and frame URL.
- **Geometry:** rectangle, viewport, scroll position and device-pixel ratio.
- **Locator evidence:** FlowLink's validated locator candidates and stable fingerprint, referenced from the capture event and step.
- **State transition:** structured page signature before and after the action; FlowLink's inferred `expect` remains on the executable step.
- **Execution provenance:** native tab ID, page index, system ID/name, URL and source event IDs.
- **Cross-system flow:** copy/paste events and tab activation/creation/closure are kept in the global sequence.

This is materially more useful for diagnosing and repairing replay than a plain click/fill log. It does not make every site deterministic: dynamic data, authentication expiry, server-side state, closed shadow roots, canvas-only controls and OS-native dialogs can still require special handling.

## 5. Privacy and data handling

- Password values remain masked by the existing FlowLink capture layer.
- The `.raw.json` evidence stream and FlowForge sidecar omit `input`/`change` values. The executable Flow IR retains the values it needs for replay under FlowLink's existing storage behavior.
- Clipboard text is never read or saved. Only copy/paste event metadata and source relationships are recorded.
- Explicit Alt+click extraction records the selected target text in the raw event; users should avoid using it on sensitive content.
- DOM signatures and visible text/attributes can still contain business information. Treat recording artifacts as sensitive operational data and store them accordingly.

## 6. Known gaps (not claimed as completed)

- FlowForge's original full HTML `beforeSnapshot` / `afterSnapshot` and overlay serialization are not copied verbatim. FlowLink uses structured DOM signatures plus target facts and locator evidence instead; this is smaller, less brittle and compatible with FlowLink's existing resolver.
- FlowForge's original standalone workflow schema and executor are not used as the replay schema. Their system/tab/source-event provenance fields are mapped into FlowLink's `BaseStepSchema`; FlowForge's separate action vocabulary is not allowed to bypass FlowLink's validated step union.
- `dragStart` / `drop`, `submit`, `dblclick`, focus/blur and clipboard events are preserved as evidence. They are not all converted into new executable FlowLink step kinds. Drag replay still needs a dedicated source/target pairing and executor adapter.
- Semantic conversion is a first compatibility projection. FlowForge's specialized Select2/widget grouping heuristics need additional regression coverage before claiming full parity.
- Hostname-to-system mapping is automatic. Enterprise systems with multiple hostnames or shared identity providers will need a configurable system alias map.
- A newly opened tab is captured when it is created as a new Electron browser view and appears in the attached Playwright context. Popup and multi-tab behavior must be verified on the target Windows/Electron runtime.

## 7. Validation status

Static source checks and runtime tests must be run on the target Windows machine after dependencies are installed. This working environment does not contain the project's `node_modules`; TypeScript type-checking and Electron end-to-end launch could not be completed here. Do not treat ZIP creation as proof of a successful Electron launch.

Recommended verification:

```powershell
npm ci
npm run build
npm start
```

Then record a test flow that:

1. Opens two tabs on two different systems.
2. Switches between tabs and navigates each one.
3. Clicks a control, fills a non-sensitive test field, selects an option and submits.
4. Copies a non-sensitive value in tab A and pastes it in tab B.
5. Stops recording and verifies both the Flow JSON and `flowforge-recording.json` exist.
6. Checks that events have monotonic sequence numbers, correct tab/system IDs, before/after snapshots, locator evidence and `flowStepId` links.
7. Replays the FlowLink recording and inspects any unresolved locator or expected-state failures.

## 8. Important acceptance criteria

A merge should only be called production-ready after the above workflow is successfully recorded and replayed on the intended Windows environment, with no dropped tab events and no missing required target evidence. The current package implements the integration path, but this real Electron/CDP end-to-end acceptance run remains outstanding.


## 9. Navigation action and cause classification (added)

Navigation is a first-class capture event. Each navigation event preserves `previousUrl`, `url`, `navigationType`, and `navigationEvidence`. The current classifier uses explicit host navigation requests, recent captured link clicks, and authentication URL heuristics. Supported types are `initial`, `user_navigate`, `user_link`, `user_redirect`, `sso_redirect`, `login_redirect`, `auto_redirect`, `popup_navigation`, `history_navigation`, and `unknown_navigation`. Unknown is intentionally preferred over claiming a cause that the browser API did not expose.

Electron host events separately record address-bar navigation requests, `will-redirect` events, and Back/Forward/Reload requests, so the archive can distinguish a user request from the redirect chain that follows it. Authentication classification is best-effort: organizations should be able to configure IdP hostnames and login path patterns for reliable enterprise SSO classification.

## 10. Pi Coding Agent integration

FlowLink now has a main-process Pi bridge in `src/pi-agent.ts`, exposed to the renderer through `window.flowlink.pi.status()` and `window.flowlink.pi.prompt({ prompt, allowEdits?, timeoutMs? })`. It invokes the installed `pi` CLI as a subprocess (override its executable with `PI_CLI_PATH`). This avoids bundling Pi's dependency tree into Electron. The default mode exposes only read/grep/find/list tools; write-capable tools require explicit `allowEdits: true`. The agent working directory is FlowLink's generated flows directory, not an arbitrary renderer-supplied path.

Install/configure Pi separately and authenticate its model provider before using the bridge. The bridge is a first integration seam, not yet a full in-app chat UI, persistent agent session manager, or custom workflow-editing toolset. For production use, add structured tools for reading a recording archive, proposing a validated Flow IR patch, running schema validation, and requiring user approval before applying edits or executing browser actions.

## 11. Navigation validation cases

Run these cases while recording and inspect both Flow IR and `flowforge-recording.json`:

1. Start at the configured default URL: it is the recording baseline, not a user-issued navigate step.
2. Enter a different URL through FlowLink's address bar: expect `user_navigate` with the requested destination and an Electron host-intent evidence marker.
3. Click an ordinary external link: expect `user_link` when the clicked `href` matches the observed navigation.
4. Trigger corporate SSO: expect authentication transitions to be classified as `sso_redirect` / `login_redirect` when URL patterns and Electron redirect events support that conclusion.
5. Trigger a site-internal or cross-host automatic redirect: expect `auto_redirect` only when Electron's `will-redirect` event supports it; otherwise retain `unknown_navigation` and its evidence rather than guessing.
6. Use Back, Forward, Reload, and popup navigation: expect the corresponding host intent / tab evidence.

SSO rules are heuristic and must be configurable for the enterprise's identity-provider hostnames and paths before production acceptance. The event model intentionally retains evidence and confidence clues rather than asserting intent when Electron/Chromium does not expose enough information.

## 12. Pi bridge validation

- Install Pi Coding Agent CLI separately and configure provider credentials using Pi's supported setup.
- Ensure `pi --version` works in the same Windows environment that launches FlowLink, or set `PI_CLI_PATH` to the executable.
- `window.flowlink.pi.status()` should report availability.
- `window.flowlink.pi.prompt({ prompt: 'Summarize the workflow JSON files in this workspace.' })` runs with read-only tools by default.
- Only after explicit user approval should callers pass `allowEdits: true`; this enables the CLI's normal write-capable tool set and should be treated as a privileged operation.
- Pi CLI requests currently run as one-shot subprocesses with no persisted conversational session. A future in-app AI panel should add streamed output, cancellation, session persistence, structured Flow IR tools, schema validation, diffs, and explicit apply/execute approval.

The project build was attempted in this packaging environment but could not start because `node_modules` is absent (`esbuild` was not found). This archive has not been verified by a complete TypeScript build, Electron launch, live recording, or replay run.

## Pi Coding Agent SDK and AI refinement workflows (2026-11-10 update)

FlowLink now embeds Pi through the in-process `@earendil-works/pi-coding-agent` TypeScript SDK (`createAgentSession`), not by spawning the `pi` CLI. The SDK is hosted in Electron's Node main process; the renderer calls a narrow preload IPC bridge. SDK sessions are configured with `noTools: true` for this workflow-assistant path: Pi receives bounded recording/execution context in the prompt and cannot directly edit project files or run shell commands. FlowLink validates and persists any proposed workflow as a separate material.

### AI intervention points

1. **After recording stop:** once the initial recording is persisted and displayed, FlowLink opens the AI pane and asks Pi for evidence-grounded replay reliability advice. It does not rewrite the recording automatically.
2. **Selected material(s) → Refine:** selecting one or more analyzed materials and clicking Refine opens the AI pane and asks Pi to analyze the selection. It provides advice first; no new material is saved until the user explicitly asks to generate/apply a refinement.
3. **Replay failure:** failed step results and whole-run metrics are passed to Pi, which opens the AI pane and suggests likely causes and evidence-backed fixes. The source remains unchanged unless the user requests a refinement.
4. **Generate refined material:** when the user explicitly asks to generate/apply/fix/refine a step or workflow, FlowLink asks Pi for JSON containing a title, summary, executable `steps`, rationale and risks. The output is saved as a *new* recording/material. The source recording is not overwritten. Flow schema validation during persistence is the final gate; invalid output is rejected and shown as an error.

### Configuration and startup

- Install dependencies with `npm install` (this resolves the Pi SDK dependency and updates `package-lock.json` for the configured registry).
- Configure a supported model/provider using Pi's standard configuration and credentials (`~/.pi/agent` / the active Pi agent directory, depending on the installed Pi version). See the official [Pi SDK documentation](https://pi.dev/docs/latest/sdk) and [provider documentation](https://pi.dev/docs/latest/providers).
- Start with `npm start` or `npm run dev` after dependencies install successfully.
- AI calls fail clearly if the SDK package, model, provider credentials or network are unavailable. Browser recording and replay remain separate from the AI runtime.

### Validation status

Renderer JavaScript syntax checks (`node --check renderer/app.js` and `node --check renderer/bridge.js`) pass in the build workspace. A full Electron build and end-to-end test were not run because dependencies could not be installed in this environment. Before release, verify SDK session initialization with the intended provider, post-record advice, one- and multi-material Refine, explicit refined-material creation and persistence, failed replay advice, and successful replay of the newly generated material. Never treat AI-generated material as verified until a real replay passes.
