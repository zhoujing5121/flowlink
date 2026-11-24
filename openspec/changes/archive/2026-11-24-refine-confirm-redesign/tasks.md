# Tasks

## 1. 主进程 pending 机制改造

- [x] 1.1 提案四 IPC 改名为 pending 语义：`flow:saveProposal/loadProposal/applyProposal/discardProposal` → `flow:stagePending/loadPending/confirmPending/discardPending`；文件 `proposal.json` → `pending.json`；`FlowProposal` → `FlowPending`；任务元数据标记 `pendingProposal` → `pendingUpdate`；广播事件 `ai:proposal` → `ai:pending`；`src/preload.ts` 通道与 `src/main.ts` 同步改。baseVersion 校验、原子写、快照内核保持不变。验证：`npx tsc --noEmit` 通过，grep 全仓无旧通道名残留。
- [x] 1.2 从 confirm 内核抽出 `persistFlowUpdate(recording, flow, source, summary)`（历史快照 + version+1 + `parseFlow` 校验落盘）供 confirm 复用；新增 `flow:directUpdate` IPC（taskCode/recordingId/flow/summary，不做 baseVersion 校验，直接落盘）供接管修复使用。验证：`npx tsc --noEmit` 通过；confirm 仍拒绝 version 不匹配，directUpdate 无该校验（代码审阅）。

## 2. 传输层失败识别与重试

- [x] 2.1 `src/pi-agent.ts` 的 `runPiPrompt`：失败文本命中传输类特征（`other side closed`/`socket hang up`/`ECONNRESET`/`fetch failed` 等，且非超时）时间隔 1 秒自动重发同一 prompt 一次；仍失败时返回中文可操作错误文案（指向本地代理空闲超时排查，建议调大至 ≥300s）；超时不重试。验证：`npx tsc --noEmit` 通过 + 代码审阅确认重试上限为 1。

## 3. advice 意图标注契约

- [x] 3.1 `config/prompts.json` 的 `advice.prompt` 尾部增加输出要求：正文后另起一行输出 `INTENT=refine` 或 `INTENT=advice`（含义在模板中一句话写明）；`systemPrompt` 与生成模板不动。验证：JSON 合法且 `loadPromptTemplates` 校验通过（build + 启动路径无报错）。

## 4. 渲染层触发与来源求值

- [x] 4.1 `renderer/app.js`：删除 `aiRequestNeedsMaterial` 与 `state.aiSourceIds` 的全部读写；`invokeAIMerge` 来源链改为 @ 附件 > `currentAssistantItem()` > AI 列名询问（消息列出当前任务已存录制名，请用户 @ 回复；无录制则直接告知）；Refine 按钮/表单路径保持 `forceMaterial` 必定生成，表单标题计数改用提交时的显式来源。验证：grep 无 `aiRequestNeedsMaterial`/`aiSourceIds` 残留；`npm run build` 通过。
- [x] 4.2 advice 回复的 INTENT 解析：行级提取 `INTENT=refine|advice`，从展示文本剥离该行；命中 refine 时先落"正在生成…"消息再调 `pi:generateFlow`；解析失败按 advice 呈现并由渲染层固定追加兜底提示句（"如需直接生成新版本，请明确说明或使用 Refine 表单"）。验证：build 通过 + 代码审阅（剥离与兜底路径）。
- [x] 4.3 `generateRefinedMaterial` 分流改造：单 Refined 源 → `flow:stagePending`（覆盖旧 pending 时文案注明"已覆盖上一版未确认修改"）+ 用保留的 `computeProposalDiff` 生成中文变更清单（步骤增删改/分组增删改名/网关与分支变化，带步骤名）随消息呈现；Record 与多源 → 维持 `recording.persistMerged` 新条目路径。验证：build 通过 + 代码审阅确认 diff 函数保留。

## 5. AI 面板 Confirm / Discard 与 pending 恢复

- [x] 5.1 `renderAIPanel` 快捷动作条新增 Confirm / Discard 块（存在未决议 pending 时显示，带来源与版本 tooltip）：Confirm 调 `flow:confirmPending`（version 冲突时展示拒绝文案与重新生成指引），Discard 调 `flow:discardPending`；成功后刷新该录制的流程状态。验证：build 通过 + 代码审阅。
- [x] 5.2 pending 恢复：任务详情加载（或 AI 面板打开）时经 `flow:loadPending` 检测未决议 pending 并置 UI 状态（重启后快捷条仍出现）。验证：build 通过 + 代码审阅（检测时机不依赖 Process 标签页）。

## 6. 删除对比视图与 repair 直落盘

- [x] 6.1 删除 Process 对比视图：`fillProcessPanel` 的 proposal 接管分支、`fillProposalCompareView`、`renderProposalGraphWorld`、`hydrateProcessProposal` 及 app.js 中旧 apply/discard UI 调用、`renderer/index.html` 对比模板（proposal-world 等）、`renderer/app.css` 中 proposal 对比样式；保留 `computeProposalDiff`/`proposalStepSignature`。验证：grep 无 `pendingProposal`/对比视图函数残留引用；build 通过。
- [x] 6.2 `renderer/bridge.js` 接管修复分流：`item.summary` 分支由 saveProposal 改调 `flow:directUpdate`，AI 消息改为"已直接更新至 v(N)（历史快照已存）"；Record 目标的 REPAIRED- 分支不动。验证：build 通过 + 代码审阅。

## 7. 收尾

- [x] 7.1 更新 `CHANGELOG.md`（Changed：pending+Confirm 机制；Removed：对比面板；Fixed：聊天触发死循环/粘性来源/传输重试）。
- [x] 7.2 `npm run build` + `npx tsc --noEmit` 全绿。
- [ ] 7.3 真机验证（用户执行）：勾选+Refine 必生成；中文措辞聊天（如"优化一下"）→ 生成 → 变更清单 → Confirm 落盘 version+1 / Discard 丢弃；重启后 pending 仍在；pending 期间手工编辑后 Confirm 被拒；再次 refine 覆盖旧 pending；接管修复 Refined 目标直接落盘。
