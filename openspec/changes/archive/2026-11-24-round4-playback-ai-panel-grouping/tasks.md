# Tasks

## 1. rrweb 回放黑屏修复（renderer-ui）

- [x] 1.1 `renderer/app.js` mountRrwebPlayer：量测等待 iframe rect 非零的轮询复核（上限 3s、期间加载态）；新增 vendor.css 规则命中检测（`.replayer-mouse-tail` computed position），未命中时向播放器根节点注入兜底内联样式（wrapper/iframe/mouse-tail 定位三件套）并在控制台告警
- [x] 1.2 回放器错误路径显式化：样式与事件均不可用时显示明确错误信息块（非黑屏静默）
- [ ] 1.3 应用内验证：真机打开 2026-11-18 16:10 录制（跨 3 次导航）回放，确认 t=0 与拖到 30s/60s 均渲染画面

## 2. 整页步骤截图恢复（recording）

- [x] 2.1 `engine/recorder/src/capture-client.ts`：screenshotRegion 支持整帧模式（无裁剪区，整帧直接落盘，跳过 sidecar；失败回退与元素裁剪一致）
- [x] 2.2 `engine/recorder/src/record.ts`：恢复动作步骤完成后的整页截图写入（`record/screenshots/step-NNNN.png`），与元素裁剪共用串行化防竞争；`FLOWLINK_DISABLE_RECORDER_SHOTS=1` 时跳过
- [x] 2.3 `renderer/app.js`/`renderer/bridge.js`：Record 页截图墙恢复展示新录制步骤截图；无截图的旧录制显示空态说明（无占位块）
- [ ] 2.4 真机验证：录制一段含点击/输入的流程无闪烁且点击全部生效；停止后 Record 页截图墙按步骤显示

## 3. AI 面板交互（renderer-ui）

- [x] 3.1 快捷菜单状态机：`showOptions` 触发改为用户点击 Refine 按钮（新增状态位，切页/切换工作流重置）；进入分析页不再自动显示 merge/generate/optimize
- [x] 3.2 Optimize 二级展开：options 块选择 optimize 后显示预设勾选+自由文本表单（沿用现 refine 表单）；merge/generate 走各自现有流程不变
- [x] 3.3 Test 失败预设项：删除失败后自动发送 AI 消息的路径与 `#aiContinueTest` 独立按钮；快捷区新增「Analyze last failure」（点击才发失败上下文，复用 replayFailure advice 文案+failureContext）与「AI Continue」（点击触发 runAiAssistedTest）预设项，仅存在失败结果且无运行中回放时可用
- [x] 3.4 chips 表单：修复输入重置勾选（refine 模式期间表单 DOM 不因输入重建）；勾选项渲染为可移除 chips；提交组装多行 instruction（每勾选项一行 `- <preset>` + 空行 + 文本）；聊天消息按 chips+文本段渲染
- [x] 3.5 Refine 失败错误透出：`pi:generateFlow`/`pi:repairFlow` 错误对象带 detail（阶段+原因），AI 面板展示完整错误文本（可折叠）
- [x] 3.6 修复 Refine 失败（根因已实锤，见 design 决策 6）：`src/ai-refine.ts` collectTemplateRefs 的 visitAssertion 加空值守卫；生成管线对缺 `assertion` 的模型 assert/condition 步骤丢弃并追加 risk（Refine 可成功产出）；用 scratch-refine-repro/crashtest.mjs 回归（应不再崩溃、走移除路径）；真机对 16:10 录制完整 Refine 一次成功
- [ ] 3.7 真机验证：进入 Process 页无快捷菜单→点 Refine 出三菜单→Optimize 出表单；先勾选再输入不重置；消息以 chips+文本呈现；Test 失败后无自动消息、两个预设项可用；Refine 全链路成功一次

## 4. condition 语义与业务分组（flow-schema / replay-execution / renderer / ai-integration）

- [x] 4.1 `engine/schema/src/schema.ts` validateFlowContract：删除「condition 必须直接位于顶层 group」「必须是所在 group 最后一步」「目标必须是顶层组」校验；新增「分支目标必须解析到同 Flow 内已存在步骤 id」校验（字段定名 trueStepId/falseStepId 或沿用现名改语义，全链路一致）
- [x] 4.2 `engine/executor/src/run.ts`：建 stepId→扁平下标映射；分支目标存在 → 跳到目标步骤（不再限于组开头）；缺省=顺序继续（不清 branchCursor、不终止）；防环沿用按顶层组访问计数；确认有界重试与 FLOW_LOOP_LIMIT 不回归
- [x] 4.3 `renderer/flow-graph.js`：决策节点提取从「仅组末 while 尾剥」改为「组内全部 condition 位置」；分支边连到任意目标节点（组卡/组内步骤锚点，取可读性优先简化）；缺省分支画顺序继续边；`renderer/app.js` 画布渲染同步
- [x] 4.4 `config/prompts.json`：generation.autoSanitize/generation.refine/systemPrompt 的分组不变量改为「登录并入首个业务阶段组（入口导航→可选网关条件（缺省=顺序继续）→isOptional 凭据步骤→目标页断言收尾）」；condition 契约描述同步（组内任意位置、缺省=顺序继续、目标=任意已存在步骤）
- [x] 4.5 `src/ai-refine.ts`：投影/再水化对组中条件与新分支字段透传无损（STEP_SCALAR_FIELDS 更新字段名，验证）
- [ ] 4.6 真机验证：录制「进入系统+一项业务操作」→ AI Refine → 分组为业务阶段（登录在首组内不单独成组）；Test 该 REFINED 流程：已登录直达业务组、未登录走组内登录后继续；构造一个指向具体步骤的分支验证跳转

## 5. 规格与收尾

- [x] 5.1 打开 `openspec/specs/ai-integration/spec.md`，确认 Auto-refine 需求由本 change 的 REMOVED delta 在归档时移除（无需手改主 spec）
- [x] 5.2 更新 CHANGELOG.md（docs/changelog-guide.md 格式）
- [x] 5.3 `npm run build` + `npx tsc --noEmit` 全绿
