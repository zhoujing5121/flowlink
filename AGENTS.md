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
- For desktop integration, start at `electron/main.ts`, `electron/preload.ts`, and `renderer/bridge.js`.
- For task persistence, start at `electron/tasks/task-store.ts`.

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
- Add IPC channels in `electron/main.ts` and expose them only through `electron/preload.ts`.
- Keep long-lived rendering state synchronized in `renderer/bridge.js`.
- Define UI structure in `renderer/index.html`, including `<template>` elements for repeated items (e.g. `recordingLayoutTemplate`); generate HTML from JavaScript only when the structure genuinely depends on runtime data — fill templates, do not author static markup in JS.

## 编码规范（JS/TS）

适用于 `engine/`、`electron/`、`renderer/` 与注入脚本 `engine/recorder/capture/capture.js`。
`tests/` 与构建脚本不强制，特别复杂处适当添加。

### 注释
- 每个具名函数、类方法、对象方法、赋给具名常量的函数表达式或箭头函数，必须有紧邻其上的
  JSDoc 块注释（`/** ... */`）。行内匿名回调不要求，其意图由所在函数的注释说明。
- 注释是解释型的：说明这段代码为什么存在、解决什么问题、依赖什么前提、有什么约束、
  副作用或失败方式、什么情况下不该用。不要复述代码在做什么——"做什么"由代码本身表达。
- 方法内的关键代码可以加行内注释，同样必须是解释型（为什么这样写、有什么坑、什么不能改）。
- 每个模块文件顶部有 JSDoc 文件头：职责边界、不负责什么、主要使用方。
- 注释内容必须有依据（spec、调用方、文档、提交历史）。查不到依据时写已知的约束、契约
  或副作用，不编造意图。
- 改动代码时同步修正或删除相关注释；与代码不一致的注释按缺陷处理。
- 注释用中文，标识符用英文。

### 命名
- 函数名、模块级变量名、类名、文件名必须直接说明用途；不使用单字母、无信息量的缩写、
  与用途不符的名字。
- 函数内的泛称参数与局部变量（`item`、`value`、`data`）可以保留，但必须在 JSDoc 的
  `@param` 里说明它是什么。
- 改名必须在整个作用域内成套完成（声明与全部引用），并留意同名遮蔽。

### 类型标签
- `renderer/` 下的 JS：JSDoc 必须写 `@param {类型} 名字` 与 `@returns {类型}`。
- TS 文件不强制类型标签：类型由类型系统表达，JSDoc 只写意图与约束。

### 示例
```js
// ✗ 描述型：复述代码，名字没说清用途
/** 获取数据 */
function getData(id) { … }

// ✓ 解释型 + 见名知义
/**
 * 只取录制元数据，不读 Flow 本体：Flow 要等任务抽屉打开才水合，
 * 否则任务多时启动会把全部录制读进内存。
 * @param {string} taskCode 任务编码
 * @returns {RecordingMeta[]}
 */
function listRecordingMetadata(taskCode) { … }
```

命名整改不触及：Flow JSON 字段、IPC 通道名、`window.flowlink.*` 形状、`index.html`
的 `id`/`data-*` 钩子、engine 各包 `index.ts` 的导出名。

## Validation

Minimum validation:

```powershell
npm run build
npx tsc --noEmit
npm run lint
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
