# 执行计划：AI 接管强化（分支感知 / 标签页解锁 / 降级自由续跑 / 证据回传 / 闭环）

> 决策记录（2026-11-17，用户批准）：按调查报告 §4 方案执行，目标 = Test 失败后
> **流程一定可以被 AI 执行完成，并生成可用的新流程**。step 类型（§2 调查）**不改
> schema**：condition 现有语义足够，本计划的接管改造直接复用执行器的断言求值；
> Instruction 侧的分支目标编辑由 `docs/plan-instruction-revamp.md` 覆盖。
> 调查背景见 `docs/investigation-recording-flicker-step-types-instruction-takeover.md` §4。
>
> 执行约束：**不 commit、不切分支**（工作区有未提交的前期工作，全部保留）；
> 只改本计划列出的文件；验证 = `npm run build` + `npx tsc --noEmit`；完成后更新
> `CHANGELOG.md`。
> 注意：本计划假定 `docs/plan-instruction-revamp.md` 已实施完毕（label 已可编辑落盘，
> agent 任务文本直接受益）；若未实施，Phase 1-3 仍可独立先行。

## 0. 目标与验收标准

1. 含登录网关（gate condition）的 REFINED 流程接管时**不再线性走完所有组**：
   接管前本地求值网关 condition，按执行器同款路由决定子序列，跳过的组报 skip。
2. `openTab / switchTab / closeTab` 不再中止接管（`upload / script / wait-userOperation`
   仍中止，语义明确提示）。
3. 单步两败后**降级自由续跑**：把剩余步骤合并为 goal 任务交给 agent 自主完成，
   预算护栏（总 10 分钟可放宽到 15）与 abort 语义不变。
4. agent 每步成功后回传**命中元素证据**（a11y 节点 + 交互坐标），写入
   `ai-takeover.json`；`pi:repairFlow` 注入这些证据，并允许修复输出**候选重锚定**
   （candidates 回写，observed 仍不可变）。
5. REPAIRED 生成后**自动回跑一轮 Test**（最多 2 轮），结果回 UI；全绿停止，失败
   报告差异。
6. manual 步骤接管时暂停等用户确认；secret 缺失在接管开始前明确报错。
7. `npm run build` + `npx tsc --noEmit` 通过。

## 1. 背景与现状（执行会话必读）

- 接管主循环：`src/ai-takeover.ts:358-618`。要点：
  - 线性切片 `remaining = flattenSteps(flow.steps).slice(fromStepIndex)`（361-363）；
  - `UNSUPPORTED_KINDS = { upload, switchTab, openTab, closeTab, script }`（246），
    循环里遇到即 break（488-495）；`wait/userOperation` 同样 break；
  - 每步 `projectStepText`（248-305）投影 → `agent.run/followUp`（stepTask 模板，
    config/prompts.json takeover 段）→ 成功双门槛 = `mark_step_done`（stepIndex 必须
    精确匹配 currentGlobalIndex+1）+ typed `done=true`（396-424、523-524）；
  - 每步 1 次重试（530-540），两败 break（569）；预算 TOTAL 10min / STEP 150s /
    14 agent-steps（79-81）；
  - 证据文件 `runs/<runId>/ai-takeover.json`（587-596）。
- 执行器的 condition 求值与路由（照抄语义）：`engine/executor/src/run.ts:826-847`
  （evaluateAssertion → branchCursor = 目标组起点，缺省分支=结束）与
  `engine/executor/src/verify.ts` 的 `evaluateAssertion`（经 Playwright page 求值断言）。
  接管复用方式：把该函数（或等价 CDP evaluate）在 `ai-takeover.ts` 中以依赖注入
  形式调用——注意 ai-takeover 目前无 Electron 依赖，求值函数从 main.ts 以 deps
  传入（先例：resolveSystemProxy）。
- system instructions（禁开标签页等）与 stepTask/retryTask 模板：
  `config/prompts.json` `takeover` 段；模板校验在 `src/prompts.ts`（改模板无需改
  校验，键不变）。
- repair 链路：`src/main.ts:1056-1126` `pi:repairFlow`（instruction 拼装，只带失败
  label+error、AI 完成 label 列表、summary）；`renderer/bridge.js:1375-1463`
  `aiRepairFlowAfterTakeover`（自动触发在 bridge.js:1885-1887）；细化管线
  `src/ai-refine.ts`（元素库投影 / 再水化只认 `{"$ref"}`；修复输出同样受限——
  **candidates 回写需要新增受控通道**，见 Phase 4）。
- Test 触发：`renderer/bridge.js` `runFlowlinkTest`（~1290-1323）；接管入口
  `window.aiContinueFlowlinkTest`（1340-1372）与 quickbar 按钮（app.js:3636-3656）。
- 浏览器现场：接管附着同一内嵌浏览器（CDP），页面状态 = Test 失败时的现场。

## 2. Phase 1：分支感知接管

1. `startAiTakeover` 在投影前先「跑路由」：
   - 对 flattened 步骤序列做一次虚拟游标遍历（同 run.ts 的 branchCursor 语义）：
     遇到 condition 步骤时**本地求值**（deps 注入的 evaluateAssertion(page, assertion,
     target)），按结果跳组；记录每个组的进入/跳过决定。
   - 求值失败的 condition → 保守处理：不跳（按线性继续），并在首步任务文本里注明
     「gate condition could not be evaluated; continue linearly」。
   - **只对「从 fromStepIndex 到达的」第一个 condition 前的网关做求值**；后续运行中
     agent 完成的步骤可能改变路由 → 采用简化策略：接管开始时求值一次定子序列，
     运行中不再重评估（在总结里注明）。后续迭代可加 followUp 间重评估。
2. 被跳过的组：`onStep` 事件报 `{ ok: true, note: 'skipped by gate condition', skipped: true }`
   语义对齐执行器的 skip 报告（bridge.js playback:aiStep 已只写 pending/running 槽位，
   需增加 skip 状态映射，参考 playback:step 的 skip 处理 bridge.js:1540 附近）。
3. condition 步骤本身不再交给 agent 执行（从 projections 中移除，避免「使其为真」
   的歧义）。

## 3. Phase 2：解锁标签页 + 体验补丁

1. `UNSUPPORTED_KINDS` 缩减为 `{ upload, script }`；`openTab/switchTab/closeTab`
   投影补语义：`Open a new tab to <url>` / `Switch to tab N` / `Close tab N`。
   browser-use agent 有开标签页能力；`config/prompts.json` systemInstructions 的
   「Do not open new tabs」改为「Open or switch tabs only when a step requires it」。
2. manual 步骤（`execution === 'manual'`）：接管循环遇到时**暂停等用户确认**——
   复用宿主回调：ai-takeover 增加 deps.waitForUserOperation（main.ts 从
   `pendingUserOperationWaits` 模式移植一个接管专用 token 流），UI 沿用
   `playback:userOperation` 事件形态（bridge 已有对应 UI：`playbackUserOperation`
   面板，确认走 `playback:continueUserOperation`；给接管加同款 token 通道即可）。
3. secret 缺失前置检查：接管启动时若 flow 有 secret 变量而 `vars` 未提供对应值，
   直接 throw 明确错误（「Reference 页未保存密码，无法接管登录段」），渲染端
   appendAIMessage 展示。
4. 预算微调：TOTAL_BUDGET_MS 10 → 15 分钟；其余不变。

## 4. Phase 3：降级自由续跑

1. 单步两败后不再 break：进入 free-run 模式——
   - 组装 goal 任务：剩余步骤的 `stepProjection` 列表 + 每步 label +「business goal:
     complete these remaining steps in order; use mark_step_done(i) as you finish
     each; finish with done=true & note when all are done」；
   - 复用同一 agent 会话 followUp（保留现场上下文），`maxSteps` 提高到 60、
     timeoutMs 提高到 420s（受总预算约束）；
   - mark_step_done 在 free-run 里放宽：接受剩余列表中任意未完成 index（不再要求
     严格等于 current+1；执行模型改为「完成即报」，主循环被动收账）；
   - free-run 结束（done 或预算尽）后统一核算 completed/remaining。
2. UI：Test 列表中 free-run 完成的步骤同样标 AI 徽标；接管总结注明
   「completed in free-run mode」。
3. 提示词：`config/prompts.json` takeover 段新增 `freeRunTask` 模板（prompts.ts 的
  TakeoverTemplates 接口同步加一个必填键，加载校验会强制存在——注意这会让旧
  prompts.json 报错，需同文件更新示例值）。

## 5. Phase 4：证据回传 + repair 重锚定

1. 证据采集（ai-takeover 侧）：agent 每步 mark_step_done 成功后，追加一个
   `capture_evidence` 工具（或复用 page.snapshot 在主循环做）——推荐**主循环做**：
   每步成功后主进程经 CDP 抓当前页 a11y snapshot 摘要（agent 命中节点的 backendNodeId
   → role/name/id/text），存入 StepRecord.evidence 节点列表。无需模型配合。
2. `pi:repairFlow`（main.ts）instruction 注入结构化证据：失败步骤 error + AI 完成
   步骤的「命中节点摘要 + 所属库元素匹配结果」。匹配算法（主进程做，简单版）：
   命中节点的 role/name/tag 与元素库条目（ref.fingerprint/observed）做归一化比对，
   相似度 top1 超阈值 → 视为「该库元素在页面上实际名为 X」；否则作为**新元素**证据。
3. 候选重锚定通道（受控、不让模型发明选择器）：`src/ai-refine.ts` 再水化后新增
  一步 `applyReanchor(steps, library, evidence)`——仅当修复 instruction 携带 reanchor
   证据时，把「库元素 eN → 新 role/name/testid 候选（来自证据节点，source:'ai'）」
   前插进对应步骤 target.candidates（保持 score 升序、observed/fingerprint 不动）。
   生成结果照常过 parseFlow 契约校验（candidates 顺序约束会被校验，天然护栏）。
4. repair 产物沿用 REPAIRED- 另存管线（不动原始录制）。

## 6. Phase 5：闭环（自动回跑 Test）

1. `aiRepairFlowAfterTakeover` 成功创建 REPAIRED 后，自动对该新录制执行一次
   `runFlowlinkTest`（复用现有入口；`repairInFlight` 语义扩展覆盖回跑阶段）。
2. 回跑失败 → 报告 + 提示「可再次 AI Continue / 修复」，**不自动无限循环**：
   最多自动 2 轮（初始 repair + 1 次重试），UI 明示轮次。全绿 → 通知用户。
3. 自动回跑期间锁定该录制的 Run 按钮（playbackInFlight 已有互斥，补 UI 状态）。

## 7. 实施顺序与验收

1. Phase 1（路由求值 + skip 语义）→ 手工验证：录一个带登录的流程（已有 SSO 环境），
   已登录状态下 Test 故意失败 → AI Continue，观察接管是否跳过登录组。
2. Phase 2（标签页解锁 + manual/secret 补丁）→ 跨两个系统的流程接管可走完。
3. Phase 3（free-run）→ 构造一个必然首败的步骤，接管应降级续跑并总结。
4. Phase 4（证据回传 + reanchor）→ `ai-takeover.json` 含 evidence；repair 后的
   REPAIRED flow 里可见新候选（source:'ai'）。
5. Phase 5（自动回跑）→ repair 后 Test 自动跑一轮，UI 显示轮次。
6. 全程 build/tsc；CHANGELOG 更新。

## 8. 风险

- prompts.json 新增必填模板键 → 旧配置文件加载失败：同 PR 内更新 config/prompts.json
  实际值，并检查 `src/prompts.ts` 校验信息可读。
- free-run 放宽 mark_step_done 后，步骤「完成」判定变松：保留 evidence 门槛
  （mark 必须带一句话证据）+ 总预算护栏；总结里区分 strict/free-run 完成。
- 证据匹配误报 → reanchor 只前插候选（score 排序后置后），回放仍有完整旧候选链
  兜底，不会因误报而丢定位能力。
