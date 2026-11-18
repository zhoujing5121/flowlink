# Agent Instructions

This file provides repository-specific instructions for coding agents.

## Goal

Make precise, end-to-end changes while preserving the recorder/executor contract and Electron security boundary.

## Start here

- Read `package.json` and `docs/architecture.md`.
- For a capability's behavioral contract, read `openspec/specs/<capability>/spec.md`.
- For Flow changes, read `engine/schema/src/schema.ts` and `engine/schema/src/io.ts`.
- For recording changes, start at `engine/recorder/src/record.ts`, `capture-client.ts`, and `types.ts`.
- For replay changes, start at `engine/executor/src/run.ts`, `actions.ts`, and `verify.ts`.
- For desktop integration, start at `src/main.ts`, `src/preload.ts`, and `renderer/bridge.js`.
- For task persistence, start at `src/store.ts`.

## OpenSpec workflow

New requirements, plans, and implementations follow the OpenSpec contract under
`openspec/` (schema: spec-driven). `openspec/specs/` is the behavioral source of
truth for implemented capabilities; code must not contradict it — change the
spec through a change first. Workflow per change:

1. **Propose** (planning session; per the model role rules it does not touch
   code): create `openspec/changes/<name>/` with `proposal.md`,
   `specs/<capability>/spec.md` (delta), `design.md`, `tasks.md`. Proposals
   list out-of-scope and reference architecture docs instead of copying them.
   `openspec validate --change <name>` must pass, then stop for user review.
2. **Apply** (execution session): implement `tasks.md` in order, checking off
   tasks; respect the invariants and implementation patterns in this file. The
   closing tasks are always `npm run build` + `npx tsc --noEmit`;
   UI/recording/replay changes include a real-device verification task. Never
   commit — commits are user-led.
3. **Archive**: only after every task is checked, validation is green, and the
   user confirms (including real-device verification where applicable). Archive
   is user-triggered; `openspec archive` merges delta specs into main specs and
   moves the change to `openspec/changes/archive/`. No session auto-applies or
   auto-archives.

Change names are kebab-case verb-first (`add-…`, `fix-…`, `refactor-…`) without
date prefixes. Delta specs state behavior contracts only — implementation detail
belongs in `design.md` — and describe implemented or to-be-implemented behavior,
never unstarted roadmap proposals. Planning artifacts are written in Chinese;
requirement titles stay English with the SHALL/MUST statement repeated as the
first line of the body.

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
- Define UI structure in `renderer/index.html`, including `<template>` elements for repeated items (e.g. `recordingLayoutTemplate`); generate HTML from JavaScript only when the structure genuinely depends on runtime data — fill templates, do not author static markup in JS.

## Validation

Minimum validation:

```powershell
npm run build
npx tsc --noEmit
```

When the work belongs to an OpenSpec change, `openspec validate --change <name>`
must also pass.

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
- `openspec/` main specs — through change deltas only (`openspec archive`
  merges them); never hand-edit specs for behavior changes

Follow `docs/changelog-guide.md` for changelog entries. Do not create new
`docs/plan-*.md` — future work is tracked as OpenSpec changes, and completed
plans/investigations live in `docs/archive/`. Do not edit `.bak` files or
generated `dist/`, `capture/capture.js`, or `release/` content as source.
