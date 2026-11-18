# 计划：校验健壮性（提示词不变性 + 等待可配）与条件分支可视化

日期：2026-11-16。来源：两次回放失败诊断（详见下文背景）。

## 背景（诊断结论，实现前必读）

1. **flow_mwhgfqwe（REFINED 废品交易申请查询）回放失败**：AI 细化流程把业务单号链接
   `SR_378` 当作"是否进入申请列表页"的判断地标（`g1/c1` condition 门控与 `g2/a1` assert）。
   会话有效时（11-15 17:22 运行）单号在列表里，流程正常；需要真正登录的三次运行
   （11-15 18:54、19-17，11-16 08:46）登录步骤本身通过，但登录后 assert 全部失败——
   失败现场快照显示 URL 已是目标页但页面内容空白（SSO 后 SPA 首屏慢），且单号本身
   不保证在默认列表里。两个因素叠加：**地标易变** + **等待不可配**。
2. **条件分支显示/使用问题**：引擎层分支执行正确（condition 为真时登录组完全不执行，
   `engine/executor/src/run.ts:803-824` 设 branchCursor、`run.ts:1015-1018` 跳转），
   但渲染层把它呈现成串行流程：
   - `renderer/bridge.js:1574-1588` `playback:step` **按事件到达顺序**（第一个 running/pending
     槽位）写结果，忽略 `r.stepId`。分支跳过发生后所有后续结果错位；
   - `bridge.js:1585-1587` 引擎的 `skip` 状态被映射回 `pending`，且非 pass 不推进 running
     标记，连续事件叠写同一槽位；
   - `bridge.js:1632-1640` `playback:done` 按下标用 `result.steps`（只含已执行步骤）覆盖
     前面 N 个槽位，被跳过的步骤永远 pending；
   - Test 步骤状态只有 pass/fail/running/pending（`renderer/app.js:929-938`、
     `renderer/index.html` testStepTemplate），没有 skip；
   - Process 设计视图（`app.js:3691-3793` 展平分组、`app.js:1002-1035` fillProcessPanel
     串行渲染组卡）完全没有分支表达。

## 变更 A：AI 生成提示词——判断条件不变性规则

文件：`config/prompts.json`（唯一提示词来源；只改既有字符串内容，不改结构，`src/prompts.ts`
的校验不动）。**保持 JSON 合法**；占位符 `{{key}}` 不得破坏。

### A1. `generation.refine` 增加一段（放在 Grounding rules 之后）：

> Verification and branching invariants:
> - When you add or keep `condition` / `assert` steps or `expect` checks that decide "which screen the run is on" (login gates, post-navigation checks), the check target must be stable across sessions and data changes. Choose in this order: (1) `expect: {"kind": "urlChange", "pattern": "<wildcard URL of the target screen>"}` on the step that lands on that screen (patterns support `*` wildcards; prefer a path-level pattern like `https://host/App/Screen*`); (2) a structural element from the library that exists on that screen regardless of data (navigation menu, tab bar, table container, filter inputs with stable ids); (3) a static page heading. Never use record/business identifiers (order or ticket numbers), dates, amounts, personal names, list row content, or anything that changes with data, filters, or login state.
> - On checks that follow a slow transition (SSO sign-in, first navigation into an app), set `"timeout": 15000` on that assert/expect step so the runner waits longer before failing.

### A2. `generation.autoSanitize` 登录重构段修正：

原文中两处 "target = an element that exists only on the target page after login (prefer the
target of the first business action)"（condition 门控）与 "target = the same target-page
element"（Sign-in 组末尾 assert）——在门控那句后追加约束：

> …but only if that element is data-independent: if the first business action targets volatile
> data (a record/ticket id, a date, a list row), choose a stable screen landmark from the
> library instead (navigation/tab/table element, or a filter input with a stable id), or use
> `expect: {"kind":"urlChange"}` on the entry navigation.

并在 Sign-in 组末尾 assert 那句补充：

> Give this assert step `"timeout": 15000`; post-login screens often load slowly.

## 变更 B：引擎——expect/assert 等待时长可配 + 轮询预算修正

现状：`engine/executor/src/verify.ts:28` `EXPECT_WAIT_MS = 5000` 硬编码；
`engine/executor/src/run.ts:857`（runAssertion）与 `run.ts:937`（verifyExpect）都不传 waitMs。
另有隐藏问题：`verify.ts` `visibleStateOf`/`textOf` 每次轮询调 `deps.resolveTarget`，
首次解析的元素出现等待会吃掉整个 pollUntil 预算，"轮询 5s" 名不副实。

Schema 的 `step.timeout`（`engine/schema/src/schema.ts:147`，`z.number().int().positive().optional()`）
**已存在但 executor 从未使用**——直接复用它，不改 schema 结构、不升 schemaVersion。

1. `run.ts` 两处调用改为：
   `const waitMs = Math.max(1000, Math.min(rendered.timeout ?? EXPECT_WAIT_MS, 30_000))`
   并作为第三参传入（runAssertion 的 waitMs 参数 / verifyExpect 的 waitMs 参数）。
   condition 步骤保持现状（`evaluateAssertion` 内部 0 等待，瞬时判定，不要改）。
2. `verify.ts`：给 `VerifyDeps` 增加可选字段 `pollResolveMs?: number`；`visibleStateOf`/
   `textOf` 调 `deps.resolveTarget(target, { requireVisible: false,
   ...(deps.pollResolveMs ? { elementWaitMs: deps.pollResolveMs } : {}) })`。
   `run.ts` 构造 verifyDeps 时传 `pollResolveMs: 1000`，使单次解析最多占 1s，轮询预算
   真正生效（`resolveTarget` 已支持 `elementWaitMs` 覆盖，见 `run.ts:448`）。
3. 更新 `verify.ts` 头部注释与 `schema.ts` `timeout` 字段注释（说明：用于该步
   expect/assert 等待上限，缺省 5000，上限 30000）。
4. 契约文档：`docs/architecture.md` §5 中 elementVisible/Hidden "轮询 5s" 的表述改为
   "默认 5s，可由步骤 `timeout` 覆盖（上限 30s）"（先在文件中定位实际措辞再改）。

## 变更 C：引擎——分支跳过补报 skip

现状：branchCursor 跳过的步骤不产生任何 StepResult（abort 路径 `run.ts:584` 反而会补报
skip）。目标：分支跳过时为每个被跳步骤产出 `status:'skip'` 结果，让 RunReport 自解释、
UI 对齐无需推断。

在 `run.ts:1015-1018` 的跳转处（以及 `branchCursor >= flat.length` 结束分支）：对
`flat[oldCursor+1 .. branchCursor-1]` 的每个 item 追加
`StepResult { stepId, kind, status:'skip', ms:0, log:['分支跳过：condition 选择了另一条路线'] }`
与对应 StepDetail（无 artifact），`steps.push` / `details.push` / `opts.onStep?.(...)`，
与 abort 路径的 skip 报告保持同构。注意：

- `metrics.passCount/failCount` 不计入 skip（沿用现有统计语义）；
- `stopOnFailure` 只看 fail，不受影响；
- group 访问计数（groupVisitCounts）不受影响（被跳过的组不算访问）；
- `playback:aiStep` 的 `event.stepIndex` 基于同一 `flattenSteps` 展平（`src/ai-takeover.ts:359`），
  展平顺序不变，索引语义不受本变更影响。

## 变更 D：渲染层——回放进度按 stepId 映射 + skip 状态

### D1. `renderer/bridge.js`

- `playback:step`（1574-1588）改为按 `r.stepId` 匹配：
  `const idx = item.testFlowSteps.findIndex(s => s.id === r.stepId)`（testFlowSteps 由
  `flatFlowSteps` 展平，元素保留 `.id`）；找不到再回退现有顺序启发式（兼容无 id 的旧数据）。
  状态映射：pass→pass、fail→fail、**skip→skip**（保留 r.error）。写入后，把 running 标记
  推进到"该下标之后第一个 pending/未置位"的步骤（pass 和 skip 都推进）。
- `playback:done`（1632-1640）改为按 stepId 建映射覆盖；本次 run 没有结果的步骤（理论上
  仅剩中断等罕见情形）统一置 `{status:'skip'}`。
- `playback:aiStep`（1649-1669）保持 index 语义，但仅在目标槽位为 pending/running 时写入，
  避免覆盖已定状态。

### D2. `renderer/app.js` + `renderer/index.html` + `renderer/app.css`

- `index.html` testStepTemplate 增加 `<svg data-status-icon="skip">`：灰色圆底 + 白色
  横杠（与现有 pass/fail/pending 图标同规格）。
- `app.js` `testStepNode`（929-938）：label 映射加 `skip → "Skipped"`；沿用
  `status-skip` class 与图标显隐逻辑（`data-status-icon` 机制已通用）。
- `app.css`：`.test-step.status-skip` / `.status-skip` 中性灰配色（参考 pending 黄、
  pass 绿、fail 红的现有写法）。

## 变更 E：Process 视图分支可视化（轻量方案）

**范围决定**：不做双泳道图形重写；用"分支徽标 + 条件步骤样式"表达。结构改动遵守
AGENTS.md：模板结构在 `index.html` 的 `<template>`，JS 只填充。

1. `index.html` canvasGroupCardTemplate（1470-1476）增加
   `<span class="canvas-group-branch" hidden></span>`（放 heading 按钮内或之后，实现时
   看现有布局取合适位置）。
2. `app.js` `ensureProcessGroups`（3728-3752）：遍历 `item.processFlow.steps`（含嵌套）
   收集 condition 步骤 `{stepId,label,trueGroupId,falseGroupId}`；给每个 group view 附加
   `branchEntries: [{conditionLabel, whenTrue}]`（某组作为某 condition 的 true/false 目标）。
3. `app.js` `fillProcessPanel`（1002-1035）：组卡若 `branchEntries.length` 则显示徽标，
   文案示例：`分支 · 当「检查是否已进入申请列表页面」为 否 时执行`（多条用分号连接），
   并加 class `branch-target` 供样式（虚线描边或角标，`app.css` 新增，与现有
   `.canvas-group` 风格一致）。
4. `canvasStepNode`（979-1000）：condition 步骤节点加 class `condition-step`
   （依据 `flowStep.kind === 'condition'`），`app.css` 给虚线边框/菱形角标区分。

## 验证

按用户既定偏好**只跑构建校验，不运行测试套件**：

```powershell
npm run build
npx tsc --noEmit
node -e "const p=require('./config/prompts.json'); if(!p.generation.refine.includes('urlChange')) process.exit(1); console.log('prompts ok')"
```

人工场景（Electron 应用，子代理无法真机回放；实现后列出请用户验证的清单）：
回放 flow_mwhgfqwe，观察 ① c1 为真时 Test 列表登录组显示 Skipped 而非 pending；
② c1 为假时登录组正常执行；③ Process 视图 g2/g3 组卡出现分支徽标。

## 文档

- `CHANGELOG.md`：按 `docs/changelog-guide.md` 的格式补一条（先读该指南）。
- `docs/architecture.md`：§5 expect 等待契约措辞更新（见变更 B.4）。
- README / README-zh：仅当其中提到步骤状态或校验行为时同步；否则不动。

## 边界与守则（来自 AGENTS.md，务必遵守）

- 不改 `.bak` / `dist/` / `capture/capture.js` / `release/`。
- 不给渲染层加任何 Node/Electron API；UI 结构改动走 `index.html` 模板。
- 不移除任何既有导出；所有 flow 写路径保持 Zod 解析。
- 工作区已有未提交改动（renderer/app.js、bridge.js、app.css、CHANGELOG.md 及未跟踪脚本），
  **在其上继续编辑，不得回退既有修改**；完成后不提交，报告即可。
