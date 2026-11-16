# 计划：Process 流程图（dagre）+ 每步 settle 沉降 + 快捷操作条 + 多流程溯源

日期：2026-11-16。前序：`docs/plan-verify-invariants-and-branch-visibility.md`（已实现）。

**已拍板的设计决策**（2026-11-16 两轮确认）：

1. 每步等待采用 **settle 语义**（networkIdle + DOM 静默），不做固定毫秒延时字段。
2. 流程图布局引擎**引入 dagre**（接受新增 renderer vendor 构建步骤与 ~100KB 依赖）。
3. 聊天框上方快捷条收纳**所有用户可点击的内容**——不止情境按钮，refine 预设、Continue、Generate/Optimize 入口等全部统一到快捷区；文本输入框留在 composer。
4. 流程图**直接全量替换**串行卡片视图，不做"只读总览→图上编辑→设默认"的三阶段过渡。
5. 合并 flow **不一定是单一串行工作流**：AI 融合结果可能是多个相互独立的流程。图模型按来源分段，独立段渲染为各自带 Start/End 的链；仅当存在跨段 condition 边时才连成一张图。

## 背景速览

- AI 面板的快捷操作散落在面板上部各 `data-ai-block` 区块（接管按钮在 Test 步骤列表上方，refine 预设与 Continue 在 refine 区块，Generate/Optimize 入口在欢迎区块），而聊天框 `.assistant-composer` 在面板底部（`renderer/index.html:680-800`）。
- 每步等待现状：navigate 已等 load+尽力 networkIdle（≤3s，`engine/executor/src/actions.ts:94-100,138-139`）；元素步骤靠 resolver 元素出现等待（默认 5s）；expect/assert 走 `step.timeout`（1–30s，前一份计划实现）；`wait` 步骤可显式插入。缺口：没有"这一步之后页面要沉降"的表达；引擎已有 MutationObserver 效应探针（`engine/executor/src/run.ts:108-130`，NO_EFFECT 检测）可复用为 DOM 静默判定。
- Process 画布是固定 472px 宽的垂直串行组卡列表（`renderer/app.css:3557`），平移缩放靠 transform（`renderer/app.js` bindProcessMap），组操作菜单用 getBoundingClientRect 相对卡片定位，步骤右键 Modify/Break 用"组起点+组内下标"扁平索引定位。渲染层**无打包器**（`renderer/index.html:1840-1841` 原样加载 app.js/bridge.js）。
- AI 细化可合并多个源 flow（`src/main.ts:996` pi:generateFlow 按 recordingIds 收集 flowFiles），但生成 flow 的 meta 直接继承第一个源（`src/ai-refine.ts:616-618`），`FlowSchema.meta` 只有 env/recorder——flow 级与步骤级的来源信息都完全丢失。

---

## 变更 1：AI 面板统一快捷区（R1）

目标：**所有用户可点击的内容统一放在聊天框上方一个地方**；面板主体只留信息展示。

- `renderer/index.html`：在 `#assistantChat`/`#assistantAttachments` 与 `.assistant-composer` 之间新增 `.assistant-quick-actions` 容器，迁移以下全部控件（**保留原 id**，app.js 按 id 绑定的逻辑不动）：
  - `#aiContinueTest`（Run remaining steps with AI）
  - `#assistantGroupRecord` / `#assistantGroupAdd` / `#assistantGroupInsert`（组操作；`data-ai-block="group"` 只保留 `.assistant-group-name` 上下文标题）
  - refine 预设按钮容器（`[data-refine-presets]`）与 `#refineContinue`
  - `#refineFreeText` 自由文本框**随预设一起迁入快捷区**（它是 refine 表单的一部分，与 Continue 按钮同进退）
  - "Generate flow from description" / "Optimize current flow" 入口按钮（现 `[data-ai-option]`）
  - `#assistantInput`（主聊天输入）**留在 composer**，`#executionMonitor`（纯展示）**留在 composer**
- `renderer/app.js` `renderAIPanel`：各区块显隐逻辑随控件迁移（条件不变，如接管按钮：存在失败步骤且无运行中回放/接管）；快捷区整体在无任何可用控件时隐藏；原 `data-ai-block` 区块退化为纯展示（Test 进度标题+步骤列表、组名标题）。
- `renderer/app.css`：快捷区 flex wrap 布局，按钮风格沿用 `.assistant-option`；文本框宽度受控（不超过快捷区宽）。

## 变更 2：每步 settle 沉降（R2）

语义：`settle` = 该步执行前让页面沉降（可选网络空闲 + DOM 静默），缺省不沉降、行为与现状完全一致。

- `engine/schema/src/schema.ts` BaseStepSchema 新增可选字段：
  `settle: z.object({ networkIdle: z.boolean().optional(), domQuietMs: z.number().int().min(100).max(5_000).optional(), maxMs: z.number().int().min(500).max(30_000).optional() }).optional()`
  （可选字段，向后兼容，不升 schemaVersion；注释写明语义与默认值。）
- executor 新文件 `engine/executor/src/settle.ts`：`waitForSettle(page, settle, log)`：
  - `networkIdle: true` → 等 `waitForLoadState('networkidle')`，上限 `maxMs ?? 10000`（泛化 actions.ts 的 bestEffortNetworkIdle，容忍长轮询站点不失败）；
  - `domQuietMs` → 注入 MutationObserver 记录最后变更时间戳（照搬 run.ts 效应探针的注入与 `data-rr-` 前缀过滤），轮询至"距最后变更 ≥ domQuietMs"，总上限 `maxMs ?? 10000`，到上限不报错只记日志（尽力而为语义，失败留给后续元素等待/校验判定）。
- `engine/executor/src/run.ts`：步骤主流程在 rendered 之后、元素解析/动作/校验之前执行 `if (rendered.settle) await waitForSettle(...)`；`navigate` 与 `wait` 步骤跳过（navigate 已内置等效等待，wait 本身就是等待）。
- `config/prompts.json`：refine / autoSanitize 的验证规则段补一句——慢过渡（登录后首屏、提交后大刷新、跨系统跳转）之后的第一个动作步骤可加 `"settle": {"domQuietMs": 500}` 或 `"settle": {"networkIdle": true}`。
- 可选增强（实现者评估，超量可列为后续并注明）：Instruction 步骤编辑器暴露 settle 选项；录制器对"点击后短窗口内发生导航"的 click 自动推断 `settle: {networkIdle: true}`。

## 变更 3：Process 全量改造为流程图（R3）

**直接替换串行卡片视图**（无三阶段、无视图开关）；组卡内部 DOM 复用是把风险压到可一次到位的关键。

### 架构：dagre 宏观布局 + 组卡 DOM 复用 + SVG 边层

dagre 只负责**宏观图**：节点 = 顶层组（+ Start/End 哨节点 + 未分组伪组），边 = 组间关系。组卡内部沿用现有纵向步骤卡 DOM——徽标、condition 步骤样式、点击选组、右键 Modify/Break、组操作菜单的 getBoundingClientRect 定位全部保留（卡片仍是 DOM，只是改为绝对定位放到 dagre 坐标上），SVG 边层画在卡片之下。串行视图相关代码（垂直 flex 列表样式与视图假设）移除。

- 依赖：`npm install @dagrejs/dagre`（含类型；若类型缺失补 `@types/dagre`）。
- vendor 构建：`build.mjs` 新增第四个 esbuild 入口 `src/renderer-vendor.ts`（`import * as dagre from '@dagrejs/dagre'; (globalThis as {__flowlinkDagre?: unknown}).__flowlinkDagre = dagre`），`format: 'iife'`、`platform: 'browser'`、target 与 Electron Chromium 匹配（es2022），输出 `dist/renderer-vendor.js`；`renderer/index.html` 在 app.js 之前加 `<script src="../dist/renderer-vendor.js"></script>`。渲染层取 `window.__flowlinkDagre`，**缺失时 Process 面板显示明确错误提示**（dev 忘了构建不至于白屏），不提供串行回退视图。
- 打包脚本按 AGENTS 校验一次（packager 无 files 过滤，dist 随应用目录打包，仍需确认产物在包内）。

### 图模型（新文件 `renderer/flow-graph.js`，普通 script 挂 `window.FlowGraph`）

`buildGraph(flow)` → `{ nodes, edges, segments }`，推导规则：

- **分段**：按步骤级 `sourceFlowId`（见变更 4）把可执行步骤切成连续段；无来源标注的 flow（纯录制/旧数据）= 单段，按单链处理。
- **段内**：Start 哨 → 段内第一个组；`组[i] → 组[i+1]` fall-through 实线；组内 condition 步骤（含嵌套，规则与 ensureProcessGroups 的 branchEntries 一致）→ true/false 目标组，边带 是/否 标签；目标缺省 → 段内 End 哨；目标组序 ≤ 来源组序 → 回跳边（虚线，运行时受 FLOW_LOOP_LIMIT 约束）。
- **跨段**：若 condition 边跨越段边界，则两段连为同一连通分量（一次 dagre 布局）；若没有任何跨段边，各段是**独立分量**——各自带 Start/End，dagre 自动横向排开（两个独立流程的真实形态）。
- 顶层裸步骤 → "未分组"伪组节点（兜底）。
- condition 出边从其所在组卡的对应步骤附近出发（端口近似：卡片底缘，不追求精确端口）。

### 编辑交互（一次性全量迁移，替换即生效）

- 组选择/AI 面板联动、组操作浮动菜单（增删/插入/上下移/合并/重录）、步骤右键 Modify/Break：全部在图模式下工作（卡片仍是 DOM，菜单定位逻辑照旧）。
- 结构变更（组增删/移动/合并）后**重跑 dagre 布局**并重画边层；`fit()` 按 world 内容自适应的逻辑保留。
- 实现 `fillProcessPanel` 内部仍按"先渲染卡片测尺寸 → dagre 布局 → 绝对定位 → 画边"的顺序组织。

### Test 标签页联动（一套图组件，设计态 / 回放态两种模式）

Test 标签页保留"内嵌浏览器 + AI 面板"布局（userOperation 确认、观察回放都依赖它），更新两点：

1. **AI 面板进度列表分组化**（`renderer/app.js` renderAIPanel 的 `.assistant-test-steps`）：串行平铺列表改为按组分节——组标题行（编号+名称+组级状态）+ 组内步骤行；分支未走的组整节淡化并标 "Skipped · 分支未走"；与图上的组一一对应。`testStepNode` 行级状态渲染（含 skip）沿用。
2. **Process 图回放态叠加**：`fillProcessPanel` 消费 `item.testResults`（按 stepId 对齐）——步骤行状态点、组卡结果描边（全过=绿、有失败=红、全跳过=灰）、**走过的路径边高亮、未走的分支边淡化虚线**；回放进行中停留在 Process 标签时实时刷新（现有 `playback:step` → `renderSummaryWorkspace` 链路已具备，只差 fillProcessPanel 消费状态）；有运行中回放时禁用编辑交互（复用现有 editBlockedReason 机制）。AI 接管完成的步骤在图上沿用 AI 徽标。

**展平收敛（技术前提，随本批完成）**：bridge.js 的 `flatFlowSteps` 与 app.js 的 `executableFlowSteps` 目前是两份实现且只有前者标注 `flattenedStepId`（验收前一批时发现的窄缺口）；收敛为 `renderer/flow-graph.js` 导出的**单一** `flattenFlowSteps`（含 stepId 前缀标注与 id→index 映射），Test 列表、Process 图、`playback:step/done/aiStep` 三处共用，杜绝漂移；`playback:aiStep` 一并从 index 语义改为 stepId。

## 变更 4：sourceFlows 溯源元数据（R4，flow 级 + 步骤级）

AI 融合结果可能是多个独立流程，可视化按步骤级来源分段；两级元数据都补：

- `engine/schema/src/schema.ts`：
  - `FlowSchema.meta` 新增 `sourceFlows: z.array(z.object({ recordingId: z.string().optional(), flowId: z.string(), title: z.string(), flowFile: z.string().optional() })).optional()`；
  - `BaseStepSchema` 新增 `sourceFlowId: z.string().optional()`（步骤级来源，供图模型分段与着色）。
  两个字段都**必须显式入 schema**：zod 默认 strip 未知键，不加的话保存/加载链路会把来源洗掉。可选字段，不升 schemaVersion。
- `src/main.ts` pi:generateFlow：在此处同时知道 recordingIds、flowFiles 与已加载 flow 的 id/title——构造 `sources` 数组，经 `GenerateFlowOptions` 新可选字段传入。
- `src/ai-refine.ts` generateRefinedFlow：
  - flow 级：`meta: { ...flows[0]!.meta, sourceFlows: sources }`；
  - 步骤级：再水化（rehydrate）时按步骤引用的元素库条目 `origin`（格式 `${flowId}/${stepId}...`）推断 `sourceFlowId`——取该步骤全部 `$ref` 中出现最多的源 flowId；无元素引用的步骤（navigate/wait 等）**继承前一个已标注步骤**的来源；首步无前驱时继承后向第一个标注。属启发式，注释写明。
- `recording:persistMerged` 链路原样保存（无需改）。从 REFINED flow 再细化时记**直接来源**（不递归展开，transitive 可按 flowId 追溯）。
- 纯录制 flow 不写这两个字段（undefined = 原生录制，单链展示）。
- UI：图模式组卡按 `sourceFlowId` 着色 + 图例（单来源=录制原色；多来源=色点列表）；列表兜底场景（如 Test 步骤列表）不涉及。

---

## 实施批次

1. **批次 A**：变更 1（统一快捷区）+ 变更 4（溯源元数据，含步骤级标注）。
2. **批次 B**：变更 2（settle：schema + executor + 提示词；编辑器/录制器推断为可选）。
3. **批次 C**：变更 3（vendor 构建 + 图模型 + 全量替换与编辑迁移 + Test 联动：进度列表分组化、图回放态叠加、展平收敛）。

批次间无依赖，A/B 较小，C 最大；顺序 A → B → C。

## 验证

按既定偏好**只跑构建校验，不运行测试套件**：

```powershell
npm run build
npx tsc --noEmit
node -e "const p=require('./config/prompts.json'); if(!p.generation.refine.includes('settle')) process.exit(1); console.log('prompts ok')"
```

- build 产物需含新的 `dist/renderer-vendor.js`。
- 手动场景（Electron 真机，用户执行）：快捷区控件齐全且显隐正确；带 settle 步骤的流程在慢页面上回放观察日志；流程图渲染/平移缩放/组与步骤编辑/来源着色/独立双链展示；**回放一条带分支的流程——Test 列表按组分节且未走组淡化、切到 Process 图看走过的边高亮、未走的分支淡化**；AI 细化生成后直接查看 flow JSON 确认 `meta.sourceFlows` 与步骤 `sourceFlowId` 落盘。
- 构建脚本与 Electron 资源变更（vendor 产物）→ 按 AGENTS 跑一次打包验证。

## 文档

- `CHANGELOG.md`：按 `docs/changelog-guide.md` 补条目。
- `docs/architecture.md`：settle 契约、流程图视图与图模型、sourceFlows/sourceFlowId 元数据。
- README / README-zh：检查是否有涉及段落，有则同步。

## 边界与守则（同前一份计划，来自 AGENTS.md）

- 不改 `.bak` / `dist/`（产物）/ `capture/capture.js` / `release/`。
- UI 结构在 `renderer/index.html` 的 `<template>`；JS 只填充（流程图节点/边属运行时数据，允许 JS 生成）。
- 不给渲染层加 Node/Electron API；新依赖只经 vendor 构建进入渲染层。
- 所有 flow 写路径保持 Zod 解析；schema 只加可选字段，不升 schemaVersion。
- 工作区已有未提交改动，在其上继续编辑、不得回退；完成后不 commit，报告即可。
