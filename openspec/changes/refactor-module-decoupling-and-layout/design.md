# Design

## Context

以 2026-11-26 的 `master`（`4bd1edc`）为基线。量度均为本次规划时实测（函数数为启发式统计：函数声明、方法、赋给具名常量的箭头函数，不含行内匿名回调）。

| 区域 | 现状 | 结构问题 |
|---|---|---|
| `src/` | 18 个文件 8,092 行，平铺 | 约十类职能混在一个目录；`main.ts` 2,747 行，`registerIpc()` 约 1,480 行，28 个模块级变量被各处共享 |
| `renderer/` | `app.js` 11,184 行（约 310 个顶层声明：259 个函数、50 个变量；含嵌套约 800 个函数）、`bridge.js` 2,196 行、`flow-graph.js` 1,129 行、`index.html` 2,205 行（34 个 `<template>`）、`app.css` 8,466 行 | 经典脚本共享全局作用域；`bridge.js` 运行时覆盖 `app.js` 的 19 个顶层函数、包装 3 个渲染函数、挂 9 个全局钩子；样式单文件且 126 个选择器靠先后顺序互相覆盖 |
| `engine/` | 5 个包、51 个文件；`record.ts` 1,828 行、`run.ts` 1,564 行、`schema.ts` 746 行 | 包间依赖单向但无成文规则；`record()`（约 1,570 行）与 `runFlowInBrowserContext()`（约 990 行）各是一个超长函数，且没有任何自动化测试执行到它们 |
| `tests/` | 11 个文件平铺，152 个用例 | 8 份复制的 esbuild bundle 辅助函数；5 处读源码文本做断言 |
| 注释 | 生产代码约 2,500 个函数中约 440 个（17%）有 JSDoc | 无规范、无 lint |
| IPC | 50 个 invoke 通道、14 个事件通道 | 通道名是散落在 `main.ts` 与 `preload.ts` 两处的字符串字面量 |

硬约束（来自 `AGENTS.md` invariants 与现状）：零功能变更；`observed` 证据不可变；Flow 写入必过 Zod 与契约校验；密码保持模板引用；渲染层不得接触 Node/Electron 对象；HTTP/HTTPS 导航校验留在主进程；不记录敏感值；preload 边界保持窄接口；`dist/` 产物布局与磁盘数据布局不变。

## Goals / Non-Goals

**Goals**

- 任何人（或 agent）能凭 `AGENTS.md` 的目录表在一分钟内确定新模块的落点。
- 主进程的录制、回放、Flow 编辑等能力有可被复用的入口，新触发来源不需要再改装配代码。
- Process 画布有引擎无关的接口，替换泳道/画布组件只动一个目录。
- 渲染层模块之间不再共享全局作用域，不再有"运行时覆盖函数"。
- 生产代码 100% 具名函数/方法有解释型 JSDoc，并有工具守住。
- 每个阶段结束时 `master` 可构建、可运行、可回退。

**Non-Goals**

- 不改任何用户可见行为（演示模式 mock 的删除是唯一例外）。
- 不引入 ES Module、打包器、自定义协议、TypeScript 到渲染层。
- 不拆 `record()`、`runFlowInBrowserContext()` 的内部。
- 不新增行为级测试；不改公开契约的名字。

## 决定总览

以下各项均于 2026-11-26 与用户逐项确认。

| # | 议题 | 结论 |
|---|---|---|
| 1 | 顶层分层 | 按运行时分层（engine / electron / renderer）+ 职能子目录；`openspec/`、`docs/` 是独立的管理目录，原地不动 |
| 2 | 主进程目录名 | `src/` 改名 `electron/` |
| 3 | 渲染层模块机制 | 命名空间 IIFE；不引入打包器或自定义协议 |
| 4 | 演示模式 mock | 删除；界面统一经宿主接口调用 |
| 5 | Process 画布 | 本次建立引擎无关的适配层接口 |
| 6 | `main.ts` | 协调器 + 依赖注入；IPC handler 变薄；通道名集中 |
| 7 | `engine/` 与 `tests/` | engine 做文件级拆分（原"拆大文件"决定在核实为超长函数后降级）；tests 按被测域归类 |
| 8 | CSS | 走读 → 合并、删除 → 按域拆分；基础样式留 `styles/app.css` |
| 9 | 注释适用范围 | 生产代码强制；`tests/` 与构建脚本不强制 |
| 10 | 注释回填 | 本 change 内全量回填，排在各域结构拆分之后 |
| 11 | 命名整改 | 函数级与模块级；泛称参数由 `@param` 说明 |
| 12 | JSDoc 类型标签 | 渲染层 JS 强制；TS 不强制 |
| 13 | 强制手段 | ESLint + jsdoc 插件 |
| 14 | 安全网 | 结构性基线（见 D13） |
| 15 | 停点与提交 | 每阶段停下，用户验证并提交；第 3、4 阶段内部另设停点（3.4、3.8 之后，4.3、4.10、4.12 之后）；移动与改内容分开提交 |
| 16 | 阶段顺序 | 风险从低到高 |
| 17 | 文档 | 更新相关文档并归位零散文档；只归档旧路线图 |
| 18 | 渲染层页签 | 归入 `panels/<页签>/` |

## Decisions

### D1 顶层分层与目标目录树

顶层保留三个运行时层，层内按职能细分。不采用"顶层按功能纵切"：主进程与渲染进程代码混在一棵子树里会让 Electron 安全边界从目录上消失，而被多处共用的 schema、resolver 仍需另设 `shared/`。不采用"只拆文件不建目录"：职能边界只能靠文件名前缀体现。

```text
flowlink/
├─ engine/                      纯 TS 引擎，零 Electron 依赖
│  ├─ reference/src/            （不变）
│  ├─ schema/src/               element / variable / step / flow / template / contract
│  │                            + schema.ts（再导出桶）+ io.ts + index.ts
│  ├─ resolver/src/             （不变）
│  ├─ recorder/                 capture/capture.js（不变）
│  │  └─ src/                   recording-labels.ts、recording-stability.ts + 其余不变
│  └─ executor/src/             run-evidence.ts、run-support.ts + 其余不变
├─ electron/                    原 src/：Electron 主进程 + preload
│  ├─ main.ts                   仅装配
│  ├─ preload.ts
│  ├─ ipc/                      channels.ts + register-<域>.ts
│  ├─ shell/                    startup-env.ts、main-window.ts
│  ├─ browser/                  browser-tabs.ts、engine-bridge.ts
│  ├─ recording/                recording-coordinator.ts
│  ├─ playback/                 playback-coordinator.ts、ai-continue.ts、takeover-evidence.ts
│  ├─ flow/                     flow-repository.ts、flow-pending.ts、recording-files.ts、artifact-crops.ts
│  ├─ reference/                reference-persistence.ts、reference-files.ts、reference-validation.ts
│  ├─ tasks/                    task-store.ts（原 store.ts）、process-landscape.ts
│  ├─ ai/                       pi-*.ts、prompts.ts、ai-refine.ts、ai-takeover.ts、flow-generation.ts、repair-evidence.ts
│  ├─ rrweb/                    rrweb-capture.ts、rrweb-reader.ts
│  ├─ infra/                    app-logger.ts、perf.ts
│  └─ build-entries/            renderer-vendor.ts、rrweb-inject.ts、vendor-assets.d.ts
├─ renderer/                    浏览器 UI（无打包器，命名空间 IIFE）
│  ├─ index.html                唯一页面：静态结构 + <template>；按依赖顺序加载全部模块
│  ├─ styles/app.css            基础样式
│  ├─ assets/
│  ├─ core/                     namespace、dom、state、events、format
│  ├─ host/                     host-api、ipc、electron-host
│  ├─ tasks/                    任务列表、Profile 抽屉、Service Level 级联
│  ├─ workspace/                工作区框架、页签注册表、浏览器工具栏模型、步骤格式
│  ├─ recording/                录制交互、浏览器工具栏、分组/节点重录、素材列表
│  ├─ panels/
│  │  ├─ process/               process-panel、process-model、process-editing
│  │  │  ├─ graph/              纯数据推导：flatten、numbering、graph-model、swimlane-model、layout
│  │  │  └─ canvas/             canvas-api、scene、node-views、engines/x6.js
│  │  ├─ instruction/  reference/  metric/
│  │  ├─ test/                  Test 页签：test-panel、run-controller
│  │  └─ record/                Record 页签：record-panel、session-player、player-diagnostics
│  ├─ ai/                       ai-pane、ai-quick-actions、ai-mentions、ai-advice、ai-generation、pending-update
│  ├─ shared-ui/                notifications、dialogs、icons、step-editor
│  └─ boot.js                   入口：初始化调用与顶层事件绑定
├─ tests/
│  ├─ helpers/bundle.mjs
│  ├─ architecture/             依赖边界、导出清单、IPC 契约、渲染层结构
│  ├─ engine/                   schema/、reference/、跨包用例
│  ├─ electron/                 ai/、reference/ …
│  └─ renderer/                 panels/process/graph/ …
├─ scripts/  build.mjs  package.mjs            构建（位置不变）
├─ config/  process_landscape/  resources/     运行期资源（位置与读取方式不变）
├─ docs/                                      文档（管理目录，不随运行时代码分层）
└─ openspec/                                  独立于项目运行之外的管理目录，不移动
```

各业务域目录自带自己的样式文件（`tasks/tasks.css` 等，见 D10）。Test 页签的目录按页签名命名为 `test`。这要求 `npm test` 的脚本显式指定测试文件的匹配范围（见 D15）：Node 测试运行器不带文件参数时按默认模式匹配，`test` 目录下的任何 JS 以及任何以 `test-` 开头的 JS 都会被当作测试文件执行，`renderer/panels/test/` 下的界面模块会被误跑而失败（2026-11-26 在 Node v24.22.2 上实测）。

### D2 新增模块查找规则（写入 `AGENTS.md`）

依次回答三个问题：

1. **它跑在哪？** 纯逻辑、不需要 Electron/宿主能力 → `engine/<域>/`；Electron 主进程 → `electron/<域>/`；浏览器界面 → `renderer/<功能区>/`。
2. **它属于哪个职能域？** 域名单三层对齐：

   | 职能域 | `engine/` | `electron/` | `renderer/` |
   |---|---|---|---|
   | Flow 契约与 IR | `schema/` | `flow/` | `panels/process/`、`panels/instruction/`（编辑界面） |
   | 录制 | `recorder/` | `recording/` | `recording/` |
   | 回放（界面为 Test 页签） | `executor/` | `playback/` | `panels/test/` |
   | 元素定位 | `resolver/` | — | — |
   | Reference 对象 | `reference/` | `reference/` | `panels/reference/` |
   | AI | — | `ai/` | `ai/` |
   | 浏览器与桌面壳 | — | `browser/`、`shell/`、`ipc/` | `host/`、`workspace/` |
   | 任务 | — | `tasks/` | `tasks/` |
   | 录屏回放 | — | `rrweb/` | `panels/record/` |
   | 基础设施 | — | `infra/` | `core/`、`shared-ui/` |

3. **现有域里放不下，也不能自然归入任何现有模块时才新建目录**；新建顶层目录必须在 `AGENTS.md` 的目录表里登记。

补充规则：分析工作区的页签 → `renderer/panels/<页签>/`；跨域复用的纯界面控件 → `renderer/shared-ui/`；与业务无关的渲染层基础设施 → `renderer/core/`；构建用的浏览器侧入口 → `electron/build-entries/`。

示例：加语音输入——主进程部分放 `electron/voice/`，界面部分放 `renderer/voice/`；替换泳道/画布组件——在 `renderer/panels/process/canvas/engines/` 下新增实现并换 vendor 入口，面板代码不动。

### D3 依赖方向与边界

| 规则 | 守护方式 |
|---|---|
| `engine/` 不得导入 `electron/` 或 `renderer/`；包间只允许 schema → reference、resolver → schema、recorder → schema 与 reference、executor → schema 与 resolver、reference → 无 | `tests/architecture/engine-boundaries.test.mjs` |
| `electron/` 可依赖 `engine/`；不得依赖渲染层脚本（只经 `index.html` 加载） | 同上 |
| `window.flowlink` 只允许出现在 `renderer/host/` | `tests/architecture/renderer-structure.test.mjs` |
| `window.__flowlinkX6` 只允许出现在 `renderer/panels/process/canvas/engines/`；`window.__flowlinkDagre` 只允许出现在 `graph/layout.js` 与画布 engines；`window.__flowlinkRrweb` 只允许出现在 `panels/record/` | 同上 |
| 渲染层依赖方向：`core` ← `host` ← 业务域（`tasks`、`workspace`、`recording`、`panels/*`、`ai`）；`shared-ui` 可被所有业务域使用，自身不依赖任何业务域 | 评审 + 同上（`@requires` 顺序） |
| 业务域之间不得引用对方的内部函数，只能通过 `UI.core.events`、工作区页签注册表、或目标模块显式导出的公共 API | 评审 |
| `index.html` 的脚本列表是加载顺序的唯一声明；每个模块在加载期解析并校验依赖 | 同上 |

### D4 `electron/`：协调器 + 依赖注入

**做法**：`main.ts` 里的函数体按归属**原样搬到**各协调器工厂函数内部，闭包变量变成工厂内的 `state`；不改写逻辑。`main.ts` 只剩装配。

| 模块 | 吸收的现有代码 | 拥有的状态（原 `main.ts` 模块级变量） |
|---|---|---|
| `shell/startup-env.ts` | 模块加载期的日志环境变量、CDP 开关、`DO_NOT_TRACK` | — |
| `shell/main-window.ts` | `createWindow` 中的窗口创建与加载；`waitForCdpPort` | `mainWindow` |
| `browser/browser-tabs.ts` | `syncBrowserVisibility`、`registerBrowserTab`、`createBrowserTab`、`createNativeBrowserTab`、`normalizeHttpUrl`、`resetBrowserTabs`、`createNativePlaybackPage`、`ensureBrowserBounds` 及 `browser:*` handler 逻辑 | `browserView`、`browserViews`、`browserBounds`、`browserBoundsTimer`、`activeBrowserTabId`、`browserSurfaceVisible` |
| `recording/recording-coordinator.ts` | `resetRecordingState`、`discardEmptyRecordingCapture`、`scheduleRecordingPoster`、`recordingTabLabel`、`stopRecordingSession`、`recording:start` 逻辑 | `recController`、`recStartPromise`、`recStopPromise`、`recPromise`、`recStopRequested`、`recTaskCode`、`recOutPath`、`recordingCaptureRoot`、`recordingPosterTimer`、`recordingPosterFile`、`recordingAdditionalPages`、`recordingTabIds`、`recordingTabSnapshots`、`recordingHostEvents` |
| `playback/playback-coordinator.ts` | `attachPlaybackPages`、`hostWaitForUserOperation`、`playback:run`、`playback:runPrefix`、`playback:stop`、`playback:continueUserOperation` 逻辑 | `playPromise`、`playAbortController`、`pendingUserOperationWaits` |
| `playback/ai-continue.ts`、`takeover-evidence.ts` | `attachedTakeoverPages`、`evaluateTakeoverGate`、`captureTakeoverEvidence`、`TAKEOVER_EVIDENCE_SCRIPT`、`playback:aiContinue` 编排 | — |
| `flow/flow-repository.ts` | `persistMergedFlow`、`persistFlowUpdate`、`writeFlowHistorySnapshot`、`writeJsonAtomic`、`flow:load`、`flow:updateSteps` | `flowsRoot`、`artifactsRoot`（注入） |
| `flow/flow-pending.ts` | `FlowPending`、`FlowHistoryEntry`、`PENDING_SOURCES`、`pendingPathOf`、`readPending`、`flow:stagePending`、`loadPending`、`confirmPending`、`discardPending`、`directUpdate` 逻辑 | — |
| `flow/recording-files.ts`、`artifact-crops.ts` | `managedDirectChild`、`removeRecordingFiles`；`recording:artifactsPath` 逻辑 | — |
| `reference/` | `reference-persistence.ts`（原样）+ `reference:*`、`flow:addReferenceFile`、`flow:removeReferenceFile` 逻辑 | — |
| `tasks/` | `store.ts`（原样，改名 `task-store.ts`）、`tasks:*`、`processLandscape:load` | `taskStore` |
| `ai/` | `pi-*`、`prompts`、`ai-refine`、`ai-takeover`（原样）+ `pi:generateFlow`、`pi:repairFlow` 的编排逻辑、`describeFlowStructure`、修复证据匹配（`normalizeEvidenceName`、`describeEvidenceNode`、`reanchorCandidates`、`matchEvidenceNode`、`buildRepairEvidence`）、`ai:logChat` | — |
| `rrweb/rrweb-reader.ts` | `recording:loadRrweb` 读取逻辑 | — |

**装配**（`main.ts`）：

```ts
const paths = resolveAppPaths(app.getPath('userData'))
const store = new TaskStore(paths.tasksFile)
const tabs = createBrowserTabs({ getWindow, getEngine, hooks })
const flows = createFlowRepository({ paths, store, getWindow })
const recording = createRecordingCoordinator({ paths, store, tabs, getEngine, getWindow, rrweb })
const playback = createPlaybackCoordinator({ paths, store, tabs, getEngine, flows, getWindow })
registerIpc({ store, tabs, flows, recording, playback, … })
```

- **启动顺序与现状一致**：`registerIpc()` 先于窗口创建，`EngineBridge` 在窗口创建与 CDP 端口就绪之后才建立。因此协调器通过取值函数 `getWindow()`、`getEngine()` 延迟获取窗口与引擎，handler 里"引擎未就绪"的守卫与错误文本保持原样。`main.ts` 第一条 import 必须是 `shell/startup-env.ts`，保证模块加载期副作用先于 `whenReady` 与任何 worker 创建。
- **浏览器标签页不反向依赖会话**：现状里 `registerBrowserTab`、`createWindow`、`browser:*` handler 直接读写录制状态（往 `recordingHostEvents` 推事件、往 `recordingAdditionalPages` 追加页面、挂 rrweb），`resetBrowserTabs` 直接等待在途录制/回放。改为 `createBrowserTabs({ hooks })` 注入：`hooks.recording.isActive()`、`isStarting()`、`noteEvent(e)`、`attachOpenedPage(tabId, page)`，以及 `hooks.waitForIdleSessions()`。`BrowserTabs` 只调用钩子，不导入录制/回放模块；钩子由 `main.ts` 用闭包接到协调器上。
- **向渲染层发事件**统一经注入的 `emit(channel, payload)`（内部仍是 `mainWindow.webContents.send`，保留 `isDestroyed()` 判断），通道名来自 `ipc/channels.ts`。
- **IPC 层**：`ipc/register-<域>.ts` 只做参数校验和调用协调器；校验逻辑与错误消息文本原样保留（渲染层依赖部分文本，例如 `REFERENCE_VALIDATION:` 前缀）。
- **通道名集中**：`ipc/channels.ts` 导出 invoke 通道常量与事件白名单常量；`preload.ts` 与 `register-*.ts` 都从它取值，不再手写字符串。

**不做**：事件总线、重试/策略等新语义、`RunCoordinator`/`WorkflowRepository` 的新行为——这里只是把既有代码搬到可复用的位置。

### D5 `renderer/`：命名空间 IIFE 与加载期依赖校验

- **模块形态**：每个文件是一个 IIFE，挂到 `window.FlowLinkUI`（模块内形参 `UI`）。不叫 `window.FlowLink`：它与 preload 的 `window.flowlink` 只差大小写，容易写错。
- **加载期解析依赖**：模块顶部用 `UI.require(命名空间, "名字", ["导出1", "导出2"])` 取依赖，任何一项缺失立即抛错。于是"脚本漏加载"或"顺序错"在应用启动时就暴露，而不是等到某个功能被点到。
- **加载顺序**：`index.html` 末尾的 `<script>` 列表是唯一声明（vendor 脚本仍最先）。每个模块的文件头写 `@requires` 清单，`tests/architecture/renderer-structure.test.mjs` 校验：每个模块文件在列表中恰好出现一次；`@requires` 的模块都排在它前面。
- **状态归属**：模块私有状态留在模块闭包；跨模块共享的只有会话状态（`UI.core.state`）与少数显式导出的访问器。现状 `app.js` 的 50 个模块级变量按此归位。
- **模块间通知**：`UI.core.events`（`on`/`off`/`emit`）。`bridge.js` 对 `renderAIPanel`、`renderSummaryWorkspace`、`renderRecordingWorkspace` 的包装改为：这些函数渲染完成后 `emit('workspace:rendered')`，宿主模块订阅它重报浏览器矩形。
- **页签注册表**：`UI.workspace.tabs.register({ id, fill(panel, item), reset(item) })`。`renderSummaryWorkspace` 经注册表分发到各页签的 `fill*Panel`，新页签 = 新目录 + 一行注册。

```js
/**
 * Reference 页签：对象表与活动关联。（文件头说明职责边界）
 * @requires core.state, core.dom, host.api
 */
(function (UI) {
  "use strict";
  const { byId } = UI.require(UI.core, "dom", ["byId"]);
  …
  UI.panels = UI.panels || {};
  UI.panels.reference = { fillPanel, reset };
})(window.FlowLinkUI = window.FlowLinkUI || {});
```

### D6 `renderer/`：模块划分与迁移方法

**模块映射**（起点，不是铁律：执行时按耦合情况可在同一功能区内微调，但不得跨功能区混放）：

| 目标模块 | 吸收的现有代码（`app.js` 行号为现状位置） |
|---|---|
| `core/namespace.js`、`dom.js`、`state.js`、`events.js`、`format.js` | `$`、`rowTemplate`、`escapeHTML`、`setIconHidden`（1–60）；`flowData`、`recordingSessions`、`recordingSession`、`createBrowserPage`、`activeBrowserPage`、`syncBrowserSession`、筛选状态（11–92、5181–5258）；纯格式化函数 |
| `host/ipc.js`、`host-api.js`、`electron-host.js` | `bridge.js` §3 的矩形上报与观察器、§7 事件订阅；`app.js` 中 49 处 `window.flowlink.*` 调用 |
| `shared-ui/notifications.js`、`dialogs.js`、`icons.js`、`step-editor.js` | `showFlowlinkNotice`、`showWorkspaceNotice`、`showConfirmDialog`、`confirmWorkspaceAction`、`designIcon`、`circleSymbol`、`groupFaviconUrl`、`showManualStepEditor`、`bindStepEditor`（9410–9786 的一部分） |
| `tasks/task-list.js`、`profile-drawer.js`、`service-levels.js` | 列表渲染与筛选（93–775）、`openDrawer`/`closeDrawer`/`saveProfile`、Service Level 弹层（472–775）、`bridge.js` §1–§2 |
| `workspace/layout.js`、`tabs.js`、`browser-chrome.js`、`step-format.js` | `ensureRecordingLayout`、`renderRecordingWorkspace`、`renderSummaryWorkspace`、分栏拖拽（5332–5366、5589–5723、6104–6362、11048–11184）；`updateBrowserChrome`（5418–5533）；`bridge.js` §5 步骤转换、`executableFlowSteps`、`ensureStepDetails`、`processStepLabel` |
| `recording/recording-controls.js`、`browser-toolbar.js`、`browser-session.js`、`group-recording.js`、`recording-list.js` | 录制启停与确认（5705–5825、6104–6215）、地址栏与标签页、`resetTestBrowser`/`resetRecordingForNewSession`/`resetBrowserToTaskflowStart`、`beginGroupRecording`/`finishGroupRecording`/`beginNodeRecording`/`finishNodeRecording`（7821–7987、10337–10679）、素材列表 |
| `panels/process/graph/*` | `flow-graph.js` 整体：`flattenFlowSteps`、`numberingOf`、`groupDepthOf`、`buildGraph`、`buildSwimlane`、`layoutGraph` |
| `panels/process/canvas/*` | 1086–1650 的 X6 引擎层、1651–2545 的双视图单元格构建、`measureCanvasNodeElement`、卡片 DOM 构建 |
| `panels/process/process-panel.js`、`process-model.js`、`process-editing.js` | `fillProcessPanel`/`fillProcessToolbar`/`resolveProcessViewState`/`bindProcessMap`（2064–2545、9787–10336）；`ensureProcessGroups`、`hydrateProcessFlow`、`buildProcessTabGroups`、`graphNode*`（838–1085、7966–8225、8477–8605）；组与步骤的增删改移（9410–10679） |
| `panels/instruction/*` | 2546–4192 |
| `panels/reference/*` | 4193–4366、8817–9409、10680–10789 |
| `panels/metric/metric-panel.js` | 4367–4389、8723–8816 |
| `panels/test/test-panel.js`、`run-controller.js` | Test 进度（838–1013）；`bridge.js` §6（Test 运行、AI Continue、辅助循环、修复回跑） |
| `panels/record/*` | 4390–5180、9375–9400 |
| `ai/ai-pane.js`、`ai-quick-actions.js`、`ai-mentions.js`、`ai-advice.js`、`ai-generation.js`、`pending-update.js` | AI 面板、@ 提及、Refine、pending 确认（6497–7820、8226–8476） |
| `boot.js` | `app.js` 末尾的初始化调用与顶层事件绑定 |

**迁移方法（绞杀者）**：`app.js` 在迁移期间保持可运行，每次只搬出一个模块。

1. 先落 `core/`、`shared-ui/`、`host/`。
2. 之后按"被依赖多、依赖少"的顺序搬叶子功能区（metric、record、reference、instruction），再搬 process（graph → canvas → 面板）、tasks、recording、workspace、ai。依据：耦合统计显示每个功能区对基础区（`$` 被跨区引用 462 次、`recordingSession` 39 次）都有 43–91 处引用，所以基础必须先独立。
3. 过渡期，已搬出的模块如果还要调用仍在 `app.js` 里的全局函数，必须在文件顶部用 `/* legacy-global: 名字, … */` 显式声明，供 ESLint `no-undef` 放行。这份清单是可见的迁移债务，归零后由结构测试禁止再出现。反方向上，仍在 `app.js` 的代码引用已迁出的函数时，在 `app.js` 顶部保留一行别名（如 `const $ = UI.core.dom.byId`），调用点随所在函数迁出时再改为 `UI.require`，避免一次性改动数百处调用。
4. `bridge.js` 随对应功能区一起消化，最后与 `app.js` 一并删除，由 `boot.js` 接替入口。

### D7 宿主接口与演示模式删除

**核查结论**（2026-11-26）：mock 专属代码在 Electron 内全部不可达——`bridge.js` 运行时替换了 19 个顶层函数（约 536 行），`embeddedBrowserHTML`、`browserGuideHTML`、`recordingGuideMarkup`、`embeddedSnapshotBridge`、`receiveRecordingSnapshot` 与顶层 `message` 监听器只被这些 mock 调用。唯一能用到它的场景是不经 Electron 直接用浏览器打开 `renderer/index.html`（实测仍可启动并加载模拟页，但 Service Level 不可选、录制只存内存、AI/Process/Test 均不可用），没有任何文档把它列为受支持流程。

**删除范围**：上述 mock 函数体与辅助函数；页面状态模型里恒为空的 `route`、`frame`、`showGuide` 字段及其透传（含 `bridge.js` 里的 route 赋值）；`local://procurement/…` 路由分支。`confirmWorkspaceAction`、`closeDrawer` 的本体是真实实现，保留，只去掉桥接包装。`guideAssistant` 是 AI 面板"引导阶段"的在用状态，保留；其 `steps` 字段在现有代码中未发现读取方，执行时确认后删除。每个字段的删除都以"确认无读取方"为前提。

**宿主接口 `UI.host`**（按 preload API 的分组整理；分组名按用途取，`processLandscape` → `landscape`、`pi` → `ai`；另有 `loadTaskDetails`、`reportBounds` 两个原 `bridge.js` 提供的宿主级操作）：

| 分组 | 操作 |
|---|---|
| `tasks` | `list`、`saveProfile`、`remove`、`getRecordings`、`removeRecording`、`loadTaskDetails` |
| `landscape` | `load` |
| `browser` | `reportBounds`、`hide`、`restart`、`createTab`、`switchTab`、`closeTab`、`navigate`、`goBack`、`goForward`、`reload`、`currentUrl` |
| `recording` | `start`、`stop`、`persistMerged`、`loadRrweb`、`artifactsPath` |
| `playback` | `run`、`runPrefix`、`aiContinue`、`stop`、`continueUserOperation` |
| `ai` | `status`、`prewarm`、`stop`、`prompt`、`promptTemplates`、`generateFlow`、`repairFlow`、`logChat` |
| `flow` | `load`、`updateVariables`、`updateSteps`、`stagePending`、`loadPending`、`confirmPending`、`discardPending`、`directUpdate` |
| `reference` | `catalog`、`validateObject`、`validateAll`、`addFile`、`removeFile`、`fileUrl`、`attachmentBytes` |
| `on` | 白名单事件订阅，返回取消函数 |

`host/host-api.js` 定义契约，默认实现在任何操作被调用时抛"宿主未注册"；`host/ipc.js` 是唯一接触 `window.flowlink` 的文件；`host/electron-host.js` 在加载时把 Electron 实现注册到 `UI.host`。原 `bridge.js` 里把 IPC 与界面状态揉在一起的逻辑（开始录制、导航、Test 循环……）属于业务域，迁入对应功能区并调用 `UI.host`，不算宿主实现。

### D8 画布适配层

现状：`fillProcessPanel` 一个函数约 480 行，把面板状态、视图状态、图模型、节点数据准备、尺寸实测、X6 单元格创建、overlay 揉在一起；另有第 9840–9841 行直接取 X6 实例。切分如下：

| 文件 | 职责 | 是否知道 X6 |
|---|---|---|
| `graph/*` | Flow → 图模型/泳道模型/布局坐标（纯数据） | 否 |
| `canvas/node-views.js` | 卡片 DOM 构建（模板克隆）：组卡、容器卡、哨节点、判定节点、泳道任务卡、泳道标签 | 否 |
| `canvas/scene.js` | 图模型 + 视图状态 + 回放状态 → **场景模型**（节点含实测尺寸，边含折线路由点） | 否 |
| `canvas/canvas-api.js` | `UI.panels.process.createCanvas(root, { hooks })` 与接口契约；选择引擎实现 | 否 |
| `canvas/engines/x6.js` | 节点注册、连接器、Graph 与 MiniMap 生命周期、边样式、事件桥接 | 是（唯一） |

**场景模型**（引擎无关）：

```text
scene = {
  nodes: [{ id, kind: card | container | sentinel | decision | laneTask | laneLabel,
            x, y, width, height, data, status }],
  edges: [{ id, from, to, kind: flow | branch | back, label, vertices, status }],
  world:  { width, height },
}
```

**画布实例接口**（业务代码只依赖这些）：

```text
canvas.render(scene)                     渲染场景（节点、边、坐标均已算好）
canvas.setRunState(statusById)           回放状态叠加
canvas.setSelected(nodeId | null)
canvas.setReadOnly(flag)                 回放中禁止编辑
canvas.fit(); canvas.zoomBy(factor); canvas.getZoom()
canvas.destroy()
hooks: onNodeActivate(id, event)、onNodeContextMenu(id, event, target)、onViewChange()
```

引擎实现把 `kind` 映射为自己的节点类型（X6：`flow-card`、`flow-card-container`、`flow-sentinel`、`flow-decision`、`flow-lane-task`、`flow-lane-label`）。vendor 是否加载的检测（`window.__flowlinkDagre`、`window.__flowlinkX6`）分别由 `graph/layout.js` 与 engines 以 `isAvailable()` 暴露，面板只调用它并显示原有的明确报错。工具栏、级别切换、下钻、菜单、overlay 只经 `createCanvas` 与场景模型工作。替换泳道/画布组件时新增一个 engines 文件并改 `canvas-api.js` 的选择，面板与场景构建不动。本次不启用任何 X6 编辑插件，交互语义不变。

### D9 `engine/`：文件级拆分

原"拆分 engine 大文件"的决定在核实后降级：`record.ts` 与 `run.ts` 各由一个超长函数构成，且没有自动化测试覆盖其执行路径，内部拆分留作后续 change。本次只把**顶层**函数、类型、常量分到子模块，超长函数本体原样不动。

| 包 | 新文件 | 迁入内容（原文件行号） |
|---|---|---|
| schema | `element.ts` | Rect、Candidate、Fingerprint、ObservedFacts、Frame*、Crop、ElementRef、Expect（`schema.ts` 14–121） |
| | `variable.ts` | ReferenceFile、VariableAttachment、Variable、`isSafeReferenceFilePath`（125–177） |
| | `step.ts` | BaseStep、各步骤 schema、Assertion、Step 联合、StepSchema（179–444） |
| | `flow.ts` | Env、SelfHeal、Flow（446–506） |
| | `template.ts` | `parseTemplate`、`resolveTemplate`（510–536） |
| | `contract.ts` | `FlowContractOptions`、`validateFlowContract`（538–746） |
| | `schema.ts` | 保留为再导出桶，使现有的 `../../schema/src/schema.js` 深层导入继续可用 |
| recorder | `recording-labels.ts`、`recording-stability.ts` | `applyRecordingLabels` 及其辅助；`settleFrameStability`、`waitForSilence`、`sleep`、`round2`、`clamp`（`record.ts` 114–171、1768–1828） |
| executor | `run-evidence.ts`、`run-support.ts` | `factsOf`、`captureSnapshot`、`armMutationProbe`、`activeElementSig`、`readMutationCount`；`safePageUrl`、`dialogManagerHistoryChanged`、`withTimeout`、`flashLocator`（`run.ts` 93–249） |

约束：各包 `index.ts` 的导出清单不变（由导出清单快照测试守住）；原文件对被抽走的符号做再导出，深层导入路径不破；`io.ts` 不拆（305 行，职责已集中）；`capture/capture.js` 位置不变。

### D10 CSS：走读、合并、删除、按域拆分

现状数据：1,185 条规则、953 个不同选择器；157 个选择器被声明多次，其中 126 个重复设置同一属性（后者覆盖前者），60 个的两次声明相隔超过 500 行（如 `:root` 在第 1、1000、7018、7579 行各改一次）。无 `@layer`、无 `@import`。

1. **走读**：用静态分析列出重复声明、永远被覆盖的声明、疑似无用选择器，人工复核后形成报告。疑似无用的判据：选择器里的 class/id 在 `index.html` 与全部渲染层 JS 中没有任何字面量出现。rrweb 与 X6 运行时注入的类名（`.replayer-*`、`.x6-*`）不在删除之列。
2. **合并**：只做可证明等价的合并——同一选择器、同一 at-rule 上下文、后一条声明设置了同一属性（区分 `!important` 与简写/长写）时，前一条声明不可见，删除它；删空的规则整条删除。**不搬动**保留下来的声明的位置，因为那会改变它与其他同优先级规则的先后关系。
3. **删除**：永远被覆盖的声明按第 2 步删除；疑似无用选择器的清单**先交用户过目**，确认后删除。
4. **拆分**：基础样式（design token、reset、外壳与导航、通用控件）留 `renderer/styles/app.css`；业务样式进各域目录：`tasks/tasks.css`、`workspace/workspace.css`、`recording/recording.css`、`panels/<页签>/<页签>.css`、`ai/ai.css`、`shared-ui/shared-ui.css`。`index.html` 的 `<link>` 顺序为：基础 → 外壳与工作区 → 各域；如走读后仍残留跨域覆盖关系，把这部分放进最后加载的 `styles/overrides.css`。顺序由分析脚本输出的覆盖关系约束得出，不凭感觉排。`index.html` 保持单文件（`<template>` 不引入构建无法拆分）。
5. **验证**：每一步都跑计算样式快照对等（D13），阶段末做真机视觉走查。

### D11 编码规范（写入 `AGENTS.md` 的条文）

```markdown
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

**禁改清单**（命名整改不触及）：Flow JSON 字段、IPC 通道名、`window.flowlink.*` 形状、`index.html` 的 `id`/`data-*` 钩子、engine 各包 `index.ts` 的导出名。`CONTRIBUTING.md` 的 Style 段同步替换为指向本节。

### D12 强制手段：ESLint 与 JSDoc 棘轮

| 范围 | 规则 |
|---|---|
| `renderer/**/*.js` | `no-undef`（声明浏览器全局与 `FlowLinkUI`）——拆文件后"引用了已不存在的全局名"在 lint 期暴露；jsdoc 存在性规则 + `@param`/`@returns` 及其类型标签规则 |
| `engine/**/*.ts`、`electron/**/*.ts` | TS 解析器；jsdoc 存在性规则（不要求类型标签） |
| `engine/recorder/capture/capture.js` | 浏览器全局 + jsdoc 存在性规则 |
| `tests/**`、`scripts/**`、`build.mjs`、`package.mjs` | 只做语法解析与 `no-undef` |

- **执行期修正（2026-11-26）**：项目的 `typescript` 已是 7.x 原生编译器，npm 包只含原生二进制启动器、没有 JS 编译 API，typescript-eslint（8.x，要求 `typescript >=4.8.4 <6.1.0`）无法使用，且没有任何已发布版本支持原生 TS。D12 从不要求 type-aware 规则，jsdoc 存在性规则只需语法解析，故 TS 文件改用 `@babel/eslint-parser`（+ `@babel/core`）以 `typescript` parser 插件解析；devDependencies 相应改为 `eslint`、`eslint-plugin-jsdoc`、`globals`、`@babel/core`、`@babel/eslint-parser`，不含 `typescript-eslint`。规则集按 D11 的构造清单配置 `jsdoc/require-jsdoc` 的 contexts（具名函数声明、类方法、对象方法、const 箭头/函数表达式）；当前基线违例 840（require-jsdoc 638、require-param 149、require-returns 53）。

- **棘轮**：jsdoc 规则先是 `warn`；`scripts/lint-budget.mjs` 统计 jsdoc 违例数并与 `lint-budget.json` 里的预算比较，超出即 `npm run lint` 失败。每个回填批次把预算下调到新的实际值；全部回填完成后规则改为 `error`，预算脚本移除。
- **"解释型"无法机检**：靠 AGENTS.md 条文与评审。仅注释的提交另有机器校验：`scripts/assert-comment-only.mjs` 把提交前后的文件分别去掉注释与空白后比较，必须逐字节一致。
- **依赖安装**：devDependencies 为 `eslint`、`eslint-plugin-jsdoc`、`globals`、`@babel/core`、`@babel/eslint-parser`（typescript-eslint 因 TS 7 原生编译器无 JS API 而不可用，见上）。安装后核对 `package-lock.json` 的差异只含 lint 相关条目，不得触碰 `@browser_use/pi` 的 overrides 相关条目；本仓库禁止 `npm dedupe`。

### D13 结构性基线

| 基线 | 形式 | 守住什么 |
|---|---|---|
| IPC 契约快照 | `tests/architecture/ipc-contract.test.mjs` + `snapshots/ipc-channels.json` | 50 个 invoke 通道、14 个事件通道与 preload API 分组形状在拆分前后一致 |
| engine 依赖边界与导出清单 | `tests/architecture/engine-boundaries.test.mjs`、`engine-exports.test.mjs` + `snapshots/engine-exports.json` | D3 的依赖方向；五个包 `index.ts` 的导出名单 |
| JSDoc 覆盖率棘轮 | `scripts/lint-budget.mjs` + `lint-budget.json` | 缺失 JSDoc 的数量只降不升，最终归零 |
| CSS 计算样式快照 | `scripts/css-style-snapshot.mjs`；快照写入本地 `scratch-css-snapshot/`（已 gitignore），不入库 | 样式合并/删除/拆分前后，同一界面状态下全部元素的计算样式一致 |
| 渲染层结构规则（第 4 阶段末加入） | `tests/architecture/renderer-structure.test.mjs` | D3 的渲染层规则、加载清单与 `@requires` 顺序、无遗留 `legacy-global` |

IPC 契约基线最初从 `preload.ts` 源码提取通道字面量；通道常量落地后改为从 `ipc/channels.ts` 取，比对的是同一份快照。CSS 快照工具经 CDP 附着正在运行的渲染进程（端口取自 `DevToolsActivePort`），按预设的界面状态清单驱动界面并导出全部元素的计算样式（排除动画与时间敏感属性）；只在应用空闲时运行。

### D14 `tests/` 归类

| 现文件 | 新位置 |
|---|---|
| `flow-authoring.test.mjs`、`nested-grouping.test.mjs` | `tests/engine/` |
| `flow-schema-v3.test.mjs` | `tests/engine/schema/` |
| `reference-engine`、`reference-files`、`reference-recording-labels` | `tests/engine/reference/` |
| `reference-attachments`、`reference-ai-labels`、`execution-mode`、`pi-knowledge` | `tests/electron/reference/`、`tests/electron/ai/` |
| `swimlane-levels.test.mjs` | `tests/renderer/panels/process/graph/` |
| 新增 | `tests/architecture/`、`tests/helpers/bundle.mjs` |

`tests/helpers/bundle.mjs` 提供唯一的 esbuild 打包辅助函数，替换 8 份复制。5 处读源码文本的断言随源文件移动改指向新路径；其中"skills 只在生成入口传递"这条涉及安全边界，`main.ts` 拆分后改为同时检查 `electron/ai/flow-generation.ts` 与 `electron/ipc/register-ai.ts`，断言意图不变。

### D15 构建、类型检查与路径敏感点

| 位置 | 约束 |
|---|---|
| `build.mjs` entryPoints | 改为 `electron/` 下的新路径；输出（`dist/main.js`、`dist/preload.cjs`、`dist/pi-agent-worker.js`、`dist/renderer-vendor.js`、`dist/rrweb-inject.js` 等）的位置与名称不变 |
| `build.mjs` external | 含 pi-ai 嵌套路径字面量，与导入说明符逐字对应。**执行期修正（2026-11-27）**：external 的说明符由 esbuild 按字面量保留、运行时从 `dist/main.js` 解析，因此必须恒为 `../node_modules/…`（dist 深度），不随源文件下沉而改为 `../../…`——按原处方改为 `../../` 后应用启动即 ERR_MODULE_NOT_FOUND（`E:\node_modules\…`）。构建期 tsc/esbuild 的解析深度要求与运行期相反，由 `electron/pi-ai-nested.ts` 再导出垫片化解：垫片位于 electron/ 根（与 src/ 时代同深度，tsc/esbuild 可解析），ai-takeover.ts 改从垫片导入，external 字面量与垫片说明符逐字对应 |
| `CAPTURE_SCRIPT_PATH`（`capture-client.ts`） | 相对 `dist/main.js` 解析 `../engine/recorder/capture/capture.js`；`capture.js` 与 `dist/main.js` 都不动，常量不动 |
| `INJECT_JS_PATH`、Pi worker 的 `new URL("./pi-agent-worker.js", import.meta.url)` | 相对 `dist/main.js`，不动 |
| `app.getAppPath()` 相对资源（`renderer/index.html`、`dist/preload.cjs`、`resources/`、`config/`、`process_landscape/`） | 不动 |
| `tsconfig.json` include | `src/**/*.ts` → `electron/**/*.ts`；并试把 `engine/**/*.ts` 显式纳入类型检查（零新增错误才纳入，否则保持现状并记录） |
| `package.json` 的 `test` 脚本 | `node --import tsx --test` → `node --import tsx --test "tests/**/*.test.mjs" "tests/**/*.test.ts"`（原因见 D1）；某个 glob 零命中不会导致失败 |
| `index.html` | 脚本引用改为模块清单；`app.css` 引用改为 `styles/app.css` + 各域样式 |
| 测试的 bundle 入口与源码文本读取路径 | 随文件移动更新 |

### D16 文档更新与归位

| 文档 | 改动 |
|---|---|
| `AGENTS.md` | "Start here" 路径表改为新目录；新增"目录表与新增模块查找规则"（D1、D2）、"依赖方向"（D3）、"编码规范"（D11）；Implementation patterns 中涉及 `src/main.ts`、`src/preload.ts`、`renderer/bridge.js` 的条目改写；更正"`capture/capture.js` 是生成物"的过时表述（它是手写的注入脚本）；更正 OpenSpec 校验命令的写法——已安装的 CLI 2.2.0 不支持 `--change <name>`，可用写法是 `openspec validate <name> --type change` |
| `CONTRIBUTING.md` | 更正"没有 lint/测试脚本"的过时描述；Style 段指向编码规范；补充 lint 命令 |
| `README.md`、`README-zh.md` | 目录结构图更新（现状图里还列着早已不存在的 `capture/`，且缺 `engine/reference`、`tests/`、`scripts/`、`config/`） |
| `docs/architecture.md`、`docs/technical-architecture.md` | 运行时分层图与 Source map 更新；新增一节"模块边界与依赖方向"指向 AGENTS.md |
| `docs/response-map.md` | 架构总览与各场景调用链里的模块路径更新为新路径；正文里 `文件:行号` 形式的定位引用保留原值，文首注明行号为重构前基准并附"旧路径 → 新模块"映射表 |
| `CHANGELOG.md` | 按 `docs/changelog-guide.md`：目录布局对贡献者可见，记一条 Changed；其余内部重构不记 |
| 归位 | 根目录 `Pi integration configuration.md` → `docs/pi-configuration.md`；`ui_prototype/` → `docs/design/ui-prototype/` |
| 归档 | `docs/architecture-refactor-roadmap-2026-11.md` → `docs/archive/`，归档说明注明其结构部分已被本 change 取代、功能部分仍是路线图 |
| 留在原处 | 泳道三档计划与画布选型文档：只更新路径引用，并在头部加状态说明（结构前提已由本 change 提供，方案本身未实施） |

## 提交纪律与推进方式

- 按风险从低到高分 7 个阶段（见 `tasks.md`）：基线与工具 → 纯搬迁 → engine → electron → renderer → CSS → 收尾。每阶段末尾是停点：自动化验证全绿，用户真机验证并提交后再进入下一阶段。第 3、4 阶段体量最大，内部另设停点（3.4、3.8 之后；4.3、4.10、4.12 之后），规则相同——先跑全量自动化验证，真机范围是自上一停点以来各任务列出的验证项。
- 三种提交分开：**移动/改名**（`git mv` + 仅路径字面量修改）、**结构改动**（拆分、抽取）、**注释**（经"去注释后等价"校验）。命名整改单独成提交，不与注释混合。
- 重构进行期间不要在同一批文件上并行功能改动；如必须并行，先完成对应域的拆分再开工。

## 与既有重构文档的对应关系

| 既有建议 | 本次处理 |
|---|---|
| 路线图 §2.1 的四个服务边界 | 只做"把既有代码搬到可复用位置"：BrowserTabs、RecordingCoordinator、PlaybackCoordinator、FlowRepository 对应现有代码；InteractionGateway（语音）与任何新语义不做 |
| 路线图 §7 文件/模块演进 | `schema.ts` 拆分、`main.ts` 拆分、`app.js` 拆分、`flow-graph.js` 专注数据采纳；ControlFlow adapter、Run 状态管理、typed voice/run API、Proposal 不做 |
| 路线图 §9 目录演进 | 被 D1 的目录树取代（以当前代码为基线，不预设未实施能力的目录） |
| 路线图 §3–§6（Schema v3+、Process Studio、语音、Agent 模式） | 不在范围；本 change 只提供结构落点 |
| 泳道三档计划与画布选型 | 方案未实施，保持原位；本 change 的画布适配层使任一档落地时不必再改面板编排 |

## Risks / Trade-offs

| 风险 | 应对 |
|---|---|
| 渲染层拆分没有类型检查，拆错引用只能运行时发现 | ESLint `no-undef`；加载期依赖校验让漏加载在启动时暴露；结构测试校验加载清单；过渡期的全局引用必须显式声明；每次只搬一个模块并真机走查 |
| `main.ts` 拆分改变初始化顺序或闭包语义 | 函数体原样搬运；IPC 契约快照；按域逐个抽协调器；每步真机录制与回放 |
| 命名整改在无类型检查的 JS 里碰到同名遮蔽 | 只改函数级与模块级名字；作用域内成套改名；改名单独提交并过 lint、测试与真机 |
| 注释回填编造意图 | 只写有依据的内容；仅注释的提交经"去注释后等价"校验；按域分批评审 |
| CSS 合并与拆分引起视觉回归 | 只做可证明等价的合并；删除清单先过目；每步计算样式快照对等；阶段末全量视觉走查 |
| 路径敏感点（嵌套 pi-ai 导入、esbuild external、`dist/` 相对路径） | D15 逐项列出；纯搬迁阶段后立即做一次启动、录制、回放、Pi 问答的冒烟；收尾阶段跑一次打包验证 |
| 新增 devDependencies 触动 lockfile | 安装后核对 lockfile 差异只含 lint 条目；禁止 `npm dedupe` |
| 长周期 change 与并行功能开发冲突 | 每阶段都可构建、可回退；同一批文件不并行 |
| git 历史被大改动打断 | 移动/改名与内容修改分开提交 |
| 演示预览失效 | 已确认接受；设计稿仍在 `ui_prototype/`（归位后在 `docs/design/ui-prototype/`） |

## Migration Plan

无数据迁移、无运行时开关。每个阶段结束时 `master` 可构建可运行，回退 = revert 该阶段的提交。演示预览的消失不需要迁移。

## Open Questions

无未决事项。以下在执行期确定并回写本文件：各渲染层模块的最终文件边界（D6 映射为起点）；lint 相关依赖的具体版本与规则选项（以所装版本为准）；CSS 可删除规则的最终清单（走读后交用户确认）。
