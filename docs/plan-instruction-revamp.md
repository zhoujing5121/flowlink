# 执行计划：Instruction 页面双层呈现 + 编辑真落盘

> 决策记录（2026-11-17，用户批准）：按调查报告 §3 方案执行——**不做纯文本 DSL**，
> 改为「行层自然语言（可编辑、落盘）+ 技术抽屉（按类型结构化字段、落盘）」，
> 前置修复「编辑不落盘」缺陷。调查背景见
> `docs/investigation-recording-flicker-step-types-instruction-takeover.md` §3。
>
> 执行约束：**不 commit、不切分支**（工作区有未提交的前期工作，全部保留）；
> 只改本计划列出的文件；验证 = `npm run build` + `npx tsc --noEmit`；完成后更新
> `CHANGELOG.md`。

## 0. 目标与验收标准

1. Instruction 编辑**真正落盘**：所有编辑经 `processFlow` + `flow:updateSteps`
   （校验失败内联报错并回滚，不写坏 Flow 文件）。本地草稿路径
   （`rebuildTestFlowFromItem` 的伪 target 重建）**删除**。
2. 行层：每步显示一句自然语言（`step.label` 优先，无 label 用现有合成文案兜底），
   行内可直接编辑 = 写回 `step.label`；分组标题用 `group.label`（业务阶段名），
   Tab/URL 降为副标题徽标。
3. 技术抽屉：展开每步出现按 kind 的结构化字段（见 §3 字段矩阵），编辑即落盘；
   「目标」改为**证据查看器**（crop 截图 + 候选列表 + fingerprint 摘要），
   不再提供自由文本改定位。
4. 「AI 润色步骤描述」一键：调用现有 Pi 管线（`pi:generateFlow`，instruction 限定
   「仅为每步生成业务语言 label，不改步骤结构/元素/变量」），结果另存 REFINED
   流程的既有管线（或经用户确认后写回当前 Flow 的 label —— 采用后者更轻，见 §4）。
5. 旧数据兼容：无 `step.label` 的原始录制显示不变差；Test/Process 视图与 Instruction
   的步骤对齐（同一 `flattenFlowSteps` 索引）不回归。
6. `npm run build` + `npx tsc --noEmit` 通过。

## 1. 背景与现状（执行会话必读）

- Instruction 面板：`renderer/app.js` `fillInstructionPanel`（~1798-1843）+
  模板 `renderer/index.html:1668-1735`（`instructionGroupTemplate` /
  `instructionStepTemplate`）；展开/收起绑定 `bindStepEditor`（app.js:4615-4664）。
- **核心缺陷**：`bindStepEditor` 只改本地草稿 `item.steps/stepDetails`；processFlow
  已加载时编辑被 `rebuildItemTestFlow`（app.js:4591-4613）忽略，未加载时走
  `rebuildTestFlowFromItem`（app.js:4553-4589）用「单一 text 候选」伪 ElementRef 重建
  测试流（改「目标」= 丢证据链）。
- 已有的正确管道（照抄即可）：`hydrateProcessFlow`（app.js:4354-4400，加载真实 Flow
  并包组）、`syncProcessFlowPresentation`（app.js:4402-4414，Flow → 展示模型）、
  `persistProcessFlow`（app.js:4416-4430，`flow.updateSteps` 校验 + .bak 备份 + 回滚
  模式参考 Process 拆组 app.js:5781-5794）。
- Process 手动步骤编辑器已有按 kind 字段矩阵 `fieldsByKind`（app.js:5283-5300）与
  元素库引用选择（`targetReferences`，app.js:5235-5262）。
- 文案映射 `STEP_KIND_TEXT`（app.js:874-893）；行文本兜底合成 `processStepLabel`
  （app.js:4257-4283，已优先 `step.label`）；bridge 侧 `flowStepToText`
  （renderer/bridge.js:1109-1162）。
- 主进程 `flow:updateSteps`（src/main.ts:1634-1656）与 schema 契约校验是唯一落盘
  通道（parseFlow + saveFlow backup）。
- 元素证据：`step.target` = `ElementRef`（observed/candidates/fingerprint/crop.ref，
  engine/schema/src/schema.ts:97-108）；crop 截图文件在 artifacts 目录，渲染端已有
  file:// 直读先例（app.js fillRecordPanel 的 screenshots）。

## 2. 前置修复：编辑管线挂到 processFlow（本计划最重要的部分）

1. 打开 Instruction 标签页时按需 `hydrateProcessFlow(item)`（已是幂等：
   `processFlowLoaded` 守卫）。Instruction 只在 hydrate 成功后渲染编辑 UI；失败显示
   `processFlowError`（同 Process 页体验）。
2. `bindStepEditor` 重写为「编辑 processFlow.steps 内的对应步骤对象」：
   - 展示模型不再用独立的 `item.steps/stepDetails` 数组；渲染直接读
     `flattenFlowSteps(processFlow.steps)`（`renderer/flow-graph.js`，与 Test/Process
     同源，杜绝索引漂移）。
   - 任何字段编辑 → 更新步骤对象 → `persistProcessFlow(item)`（防抖 500ms；失败
     内联报错 + 恢复编辑前值）。
3. 删除 `rebuildTestFlowFromItem` 及其调用（`rebuildItemTestFlow` 只保留 processFlow
   与已保存 Flow 两条路径）；`ensureStepDetails` 仅保留给 mock/演示兜底，不再参与
   真实录制条目。
4. 检查并清理 `flowStepToText`/`flowStepToDetail`（bridge.js）在停录后
   `item.steps/stepDetails` 的写入：停录后直接走 hydrate 路径（保持
   `syncProcessFlowPresentation` 生成展示文本），消除两套文本来源。

## 3. UI：双层呈现

### 3.1 行层（默认，面向终端用户）

- 每组一张卡：标题 = `group.label`；副标题徽标 = `Tab N · host/path`（保留现分组
  的 tab 归属信息）；分支进入条件（`branchEntries`，app.js:4297-4305）以小徽标
  展示（如「登录后进入」）。
- 每步一行：序号 + 一句话（`step.label` 或兜底合成）+ 状态徽标（Manual/Automation
  来源、isOptional、execution=manual）。行内点击进入编辑（textarea 自动高度），
  保存 = 写 `step.label` + persist。
- 步骤级操作菜单（复用 Process 的 step menu 形态）：上移/下移/删除/在此后插入步骤
  （插入走 §3.2 的字段表单 + 元素库引用，同 Process 手动步骤编辑器）。

### 3.2 技术抽屉（展开，面向技术用户）

按 kind 显示字段（在 Process `fieldsByKind` 基础上扩充），全部编辑即落盘：

| kind | 字段 |
|---|---|
| 全部 | label、timeout、isOptional、execution(manual/automated)、settle(domQuietMs/networkIdle/maxMs)、expect(kind+参数) |
| navigate | url |
| click | 目标查看器、button、clickCount、position(只读展示 closed-shadow 坐标) |
| input / select | 目标查看器、value（模板串，secret 显示掩码提示）、clear |
| key | key、modifiers、目标查看器(可选) |
| wait | condition(element/networkIdle/timeout/userOperation)、ms、prompt、目标查看器 |
| assert / condition | 目标查看器、assertion(kind+equals/contains)、condition 额外：trueGroupId/falseGroupId（下拉=顶层组） |
| extract | 目标查看器、into、prop、attr |
| upload | 目标查看器、files（模板串列表） |
| dialog | action、promptText |
| openTab / switchTab / closeTab | url / index |
| scroll / hover / drag | 同 Process 编辑器口径 |

**目标查看器**（替换现在的「目标」自由文本 input）：
- 展示：crop 截图（`artifacts` 相对路径 → 渲染端需要能拿到 artifacts 根：新增只读
  IPC `recording:artifactsPath(recordingId)` 或复用 `flow:load` 返回时附带——采用
  新增 IPC，路径白名单校验在主进程做）、候选列表（kind/value/score/source）、
  fingerprint 摘要（tag/role/accessibleName/stableHash）、nearbyText。
- 不可编辑定位（现路径本来就是坏的）；需要换目标 → 按钮「重录这一步」（已有分组
  重录入口 `beginGroupRecording`，指到该步所在组）或从元素库引用（同 Process 的
  targetReferences 选择器，仅引用本 Flow 已捕获的元素）。

### 3.3 「AI 润色步骤描述」

- 按钮位于 Instruction 头部；调用 `pi:generateFlow`（现有 IPC，src/main.ts:987-1053），
  `instruction` 固定为："For each step, write a short plain-language business label in
  the source labels' language. Do not change step structure, ids, elements, variables,
  groups, or any other field — only add/rewrite the `label` field of each step."。
- 结果展示 diff 预览（每行旧→新），用户确认后**直接把 label 写回当前录制**（走
  `flow:updateSteps`，version+1，.bak 自动备份）；不确认则丢弃。（不复用 REFINED
  另存管线——那是改结构的通道，这里只改文案。）
- Pi 不可用时按钮禁用并提示（`pi:status`）。

## 4. 实施步骤

1. 前置修复（§2 全部）——独立可验收：改任一字段后重启应用，Flow JSON 里对应字段
   变化、version+1、.bak 出现；Test 用新 Flow。
2. 行层 UI（§3.1）+ 行内 label 编辑落盘。
3. 技术抽屉（§3.2 字段矩阵 + 目标查看器 + 新 IPC）。
4. AI 润色（§3.3）。
5. CHANGELOG + build/tsc。

## 5. 风险

- 索引对齐回归：务必只用 `FlowGraph.flattenFlowSteps` 一条展平路径；Test 结果
  （testFlowIndexById）与 Instruction 行的映射在验收时抽查（含分组/条件分支流程）。
- persist 防抖期间切走标签页 → flush 未保存编辑（beforeunload/面板切换时强制 flush）。
- expect/settle 等复合字段的表单校验交给 `flow:updateSteps` 的契约校验兜底，UI 侧
  只做基本类型约束，不重复实现校验。
