# Agent Instructions

This file provides repository-specific instructions for coding agents.

## Goal

Make precise, end-to-end changes while preserving the recorder/executor contract and Electron security boundary.

## Start here

- Read `package.json` and `docs/architecture.md`.
- For Flow changes, read `engine/schema/src/schema.ts` and `engine/schema/src/io.ts`.
- For recording changes, start at `engine/recorder/src/record.ts`, `capture-client.ts`, and `types.ts`.
- For replay changes, start at `engine/executor/src/run.ts`, `actions.ts`, and `verify.ts`.
- For desktop integration, start at `src/main.ts`, `src/preload.ts`, and `renderer/bridge.js`.
- For task persistence, start at `src/store.ts`.

## Invariants

- Keep `observed` facts immutable record-time evidence.
- Use `candidates`, `fingerprint`, and AI/self-heal output only as resolvable or mutable resolution data.
- All flow writes must pass Zod parsing and contract validation.
- Password values must remain template references such as `{{password}}`.
- Do not add Node APIs or Electron objects to the renderer beyond the preload API.
- Keep HTTP/HTTPS navigation validation in the main process.
- Sanitize IDs, filenames, and generated artifact path segments.
- Do not log cookie values, passwords, storage state, or full sensitive flow variables.
- Preserve backward compatibility or add explicit migration for `schemaVersion`.
- Do not remove existing exports without checking all engine entry points and UI integrations.

## Implementation patterns

- Put reusable schema behavior in `engine/schema/src/`.
- Put browser-side event facts in `engine/recorder/src/capture-client.ts` and planning logic in the recorder modules.
- Put element resolution in `engine/resolver/src/`; executor action execution should use resolver APIs rather than ad hoc locators.
- Put replay artifact files through `ArtifactWriter`.
- Add IPC channels in `src/main.ts` and expose them only through `src/preload.ts`.
- Keep long-lived rendering state synchronized in `renderer/bridge.js`.

## Validation

Minimum validation:

```powershell
npm run build
npx tsc --noEmit
```

Also run the smallest relevant manual scenario:

- Recording: start URL navigation, one click, one input, stop, flow load
- Playback: flow load, successful run, failure report
- IPC/UI: task save/delete, tab navigation, bounds update
- Schema: valid load/save and invalid-flow rejection
- Packaging only when packaging scripts or Electron resources changed

## Documentation

Update documentation when a public behavior or directory layout changes:

- `README.md`
- `README-zh.md`
- `docs/architecture.md`
- `CHANGELOG.md`

Follow `docs/changelog-guide.md` for changelog entries. Do not edit `.bak` files or generated `dist/`, `capture/capture.js`, or `release/` content as source.
