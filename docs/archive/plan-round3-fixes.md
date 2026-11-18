# 执行计划（第三轮，2026-11-18 真机反馈）：bug 修复 + 单线演进提案制

> 背景：第二轮 D1/D2/E 已完成未提交。用户真机验证后提出六项（两个 bug、四项行为/功能变更），
> 设计细节经 grill-me 对齐（结论见本文各节）。分三个串行会话：
> **F（Opus）= bug 3/4 → G（Opus）= 第 1/2/6 项 → H（Sonnet）= 第 5 项 + 润色移除**。
> 执行约束同前：不 commit、不切分支、验证 = `npm run build` + `npx tsc --noEmit`、
> 完成后更新 CHANGELOG.md、行号以符号定位。

## Bug 3：登录网关误入登录组（根因已实锤，F 实施）

### 证据与根因

真实运行报告 `flow_mwlnr4uc_eswbeq/runs/run_mwlnyrt5_7kkdn3`：`g1/s2 navigate pass →
g1/c1 condition pass(false) → g2 登录三步（全 optional，SSO 记住会话被跳过）→
g2/a1 assert fail（元素不可见）`。即：**网关 condition 在导航刚完成、SPA 列表元素尚未
渲染时做了「瞬时判定」→ false → 按设计走进登录组**（登录动作被 optional 跳过，但组尾
assert 失败）。用户看到的「判断已登录却执行登录步骤」= condition 结果展示不直观 + 登录组
步骤出现在执行序列里。此前不复现是因为 resetBrowserTabs 预导航让页面早已渲染完；D1 改
`navigate:false` 后 s2 goto 在 'load' 即返回、SPA 还没画完，condition 立刻判定就扑空。

### 修改方案（F 实施，engine/executor）

1. `run.ts` 的 condition 分支：把一次性 `evaluateAssertion` 改为**有界重试求值**——
   默认窗口 4000ms、每 300ms 重评一次，任一次 matches 即跳出；`step.timeout` 可覆盖窗口
   （钳制 [1000, 30000]）。仅对 condition 生效（assert 已有自己的等待语义）；每次重试记
   stepLog（`condition retry N: not yet`）。false 分支在窗口耗尽后才确定。
2. UI 辅助（可选，小）：Test 列表里 condition 步骤的状态文案带判定结果
   （现有 `condition=true/false` note 已写日志；确保渲染端展示 note）。

验收：SSO 已登录状态下跑该 REFINED 流程，网关 true 直达业务组；冷启动慢页面也不再误入
登录组（真机验证项）。

## Bug 4：rrweb 导航后录不到内容 / 应用内回放黑屏（根因已实锤，F 实施）

### 证据与根因

最新录制 `recording-1794978215241`（71 秒）：事件流在 **5150ms 戛然而止**——用户在 ~5s
从初始页导航到新地址后没有任何事件（无新文档 Meta/FullSnapshot）。rrweb 跨导航自动重启
依赖 `Page.addScriptToEvaluateOnNewDocument`（CDP 注册）+ Playwright `exposeBinding`
（绑定注入），二者其一在新文档丢失即静默失效（boot 里 binding 不存在就 return false，
无重试；主进程只在 attach 时重试 5 次）。另：播放器量尺寸在 iframe 异步渲染完成前进行
（harness 实测 t=0 iframe 0×0，1.2s 后才正常），应用内 scale/高度按 0 计算导致画面出不了
可视区——「还是黑屏」的另一组成部分。

### 修改方案（F 实施）

1. `src/rrweb-inject.ts`：boot 里 binding 未就绪时**页内自旋重试**（如 200ms × 25 次
   ≈ 5s），就绪即真正启动；解决 init script 与 Playwright 绑定注入的顺序竞态。
2. `src/rrweb-capture.ts`：为每个 tab 记录 page 的 `framenavigated`（主框架）事件——
   导航后重新执行 evaluate boot（带现有 5×250ms 重试），并校验 init script 仍有效
   （CDP session 失效则重建 session + 重新 addScriptToEvaluateOnNewDocument）；停止时
   解绑监听。事件到达率不再依赖任何单点。
3. `renderer/app.js` mountRrwebPlayer：**延迟量测**——构造后用 rAF/timeout 轮询直到
   `reference.replayer.iframe` 的 rect 非零（上限 3s）再算 scale 与舞台高度；期间显示
   加载态。杜绝 0×0 量测。
4. 每事件流健康度落 manifest（最后一事件时间），便于后续诊断。

验收：录制「打开 A → 地址栏导航到 B → 操作」全程有事件（B 的 Meta+FullSnapshot 存在）、
回放能看到 B 页面内容；Record 页回放不再黑屏（真机验证项）。

## 第 1 项：停止自动生成 REFINED（G 实施）

- `src/main.ts` stopRecordingSession：删除 `autoRefineRecording` 触发（~789-791）；
  `src/pi-agent.ts` 的 `autoRefine` 设置与 `isAutoRefineEnabled` 一并移除（config/
  pi-settings.json 里多余字段容错忽略）；`ai:autoRefine` 事件链路与渲染端处理若无其它
  使用方则同步清理。
- REFINED 只来自用户在 AI 面板主动 Refine（`pi:generateFlow` → persistMerged 路径保留，
  但按第 6 项规则分流）。

## 第 2 项：AI Continue 只单步、两败即停（G 实施）

- `renderer/bridge.js` `runAiAssistedTest`：删除「同一单步两败 → 回退全量接管」的升级
  逻辑——两败即停，报告该步与原因，assisted 循环结束（保持 existing repair 提案链路：
  见第 6 项）。
- UI：quickbar 只保留一个「AI Continue」按钮；删除「接管全部剩余」入口（D2 加的次要
  入口）。`playback:aiContinue` 的 `mode:'remaining'` 参数保留但无调用方（或顺手删除
  调用路径，底层 ai-takeover 的 remaining/free-run 代码可留作能力，不接 UI）。

## 第 6 项：REFINED 单线演进 + 前后对比 + 历史存档（G 实施，核心特性）

### 规则（grill 对齐结论）

- AI 针对原始 Record 的 Refine/repair → 生成**新 REFINED 记录**（现状 persistMerged）。
- AI 针对已有 REFINED 记录（isMerged）的修改（面板 Refine、接管后自动 repair）→
  **不再另存新记录**，改为落盘**提案（proposal）**：Process 标签页展示当前 vs 提案的
  **并排流程图 + 差异高亮**，用户 Apply 或 Discard。
- 人工编辑保持直接生效；**每次生效（人工保存或提案 Apply）都先自动存历史快照**。
- 未应用提案持久化：重启后 Process 标签页仍显示「有待应用的更新」；新提案覆盖旧提案；
  Apply/Discard 后清除。
- 润色功能整体移除（见 H）；历史存档只存不用（无查看 UI）。
- 存量 REFINED/REPAIRED 条目共存不迁移。

### 数据与主进程（G）

1. 提案文件：`artifacts/<flowId>/proposal.json` = `{ version: 1, createdAt, source:
   'refine' | 'takeover-repair', flow（完整已校验 Flow）, summary, risks }`；原子写。
   `RecordingMeta` 增加 `pendingProposal?: { at: string; source: string }`（store.ts；
   patchRecording 更新/清除）。
2. 生成路径改造（main.ts + bridge.js）：
   - `aiRepairFlowAfterTakeover`：目标录制 isMerged → 写提案 + patch 元数据 + 事件
     `ai:proposal`（渲染端提示「流程有待应用的更新」）；目标为原始 Record → 维持现状
     （REPAIRED- 新记录）。
   - AI 面板 Refine（pi:generateFlow 成功后的保存分支）：同样按来源录制 isMerged 分流。
3. 新 IPC：
   - `flow:loadProposal(taskCode, recordingId)` → proposal（无则 null）。
   - `flow:applyProposal(taskCode, recordingId)`：存历史快照（见 4）→ parseFlow 校验
     proposal.flow → saveFlow 覆盖正式文件（version+1，沿用 .bak）→ 删除提案文件与
     pendingProposal → 返回新 flow。
   - `flow:discardProposal`：删文件与标记。
   - 全部带现有的路径/归属校验风格。
4. 历史存档（共享 helper，`artifacts/<flowId>/history/`）：
   - 每次正式 Flow 生效前写 `v<N>-<ts>.json`（生效前的完整旧版快照）+ 维护
     `history/index.json`（version、at、source: 'human' | 'refine-apply' | 'repair-apply'、
     summary）。
   - 接入点：`flow:updateSteps`（人工编辑）与 `flow:applyProposal`。写失败不阻塞主流程
     （日志告警）。
5. 渲染端（G，最大块）：
   - Process 标签页：检测 pendingProposal → 顶部横幅「有来自 AI 的更新待决定」+
     进入对比视图：左右并排两张流程图（复用 FlowGraph.buildGraph/layoutGraph 与现有画布
     渲染函数，两实例；容器各自滚动），**差异高亮**：以扁平 stepId + 组 id 对齐，
     新增=绿色、删除=红色、有变化（同 id 字段不同，含 label/expect/settle/isOptional/
     值字段）=黄色描边；底部 Apply / Discard 按钮 + summary/risks 展示。
   - Apply → `flow:applyProposal` → 重新加载 processFlow 与提案状态 → toast；Discard →
     清除并回到普通视图。
   - AI 面板消息：接管后自动 repair 生成提案时提示文案改为「已生成流程更新提案，请在
     Process 标签页查看前后对比」。
   - Test/Instruction 与提案互斥：存在未决定提案时编辑给出提示（编辑会基于当前版本，
     提案对比基于生成时快照；Apply 时若 version 已前进则提示重新生成——校验提案内
     baseVersion 与当前 version，不一致时禁用 Apply 并提示）。

### 验收

- 对 REFINED 记录：接管成功 → 自动出现提案 → Process 并排对比 + 差异高亮 → Apply 后
  流程更新、history 生成快照、提案清除；Discard 后一切还原。
- 对原始 Record：AI Refine 生成新 REFINED 条目（不提案）。
- 人工编辑若干次 → history 多份快照、index 正确。
- 重启应用后未决定提案仍在。

## 第 5 项：Process 连接线改实线（H 实施）

- `renderer/app.css:3598/3608` 两处 `stroke-dasharray` 删除（或对应边类改实线）——
  全部组间连线（顺延/分支/回跳）统一实线；颜色区分后续做（本次不做）。

## 第 7 项：移除 AI 润色功能（H 实施，grill 新增决策）

- `renderer/app.js`：REFINE_PRESETS 里的 "Optimize step descriptions (labels only)"
  移除；submitRefineOptions 的润色分流删除；润色管线函数（label-only 生成、diff 对话框
  逻辑）与 `instructionPolishTemplate`、相关 CSS 一并清理。
- Instruction 后续会重构，不留兼容层。

## 会话划分

| 会话 | 模型 | 范围 | 主要文件 |
|---|---|---|---|
| F | Opus | bug 3、bug 4 | engine/executor/src/run.ts、src/rrweb-inject.ts、src/rrweb-capture.ts、src/main.ts（watchdog 接线）、renderer/app.js（播放器量测） |
| G | Opus | 第 1、2、6 项 | src/main.ts、src/store.ts、src/pi-agent.ts、renderer/bridge.js、renderer/app.js、renderer/index.html、renderer/app.css |
| H | Sonnet | 第 5、7 项 | renderer/app.css、renderer/app.js、renderer/index.html |

串行 F→G→H。真机验证清单：bug 3（SSO 已登录直达业务组）、bug 4（跨导航录制+回放画面）、
提案全流程、原始 Record Refine 仍出新条目、连线实线、AI 面板无润色预设。
