# Design

## Context

见 proposal.md（Why）。现状事实（本会话已核实）：提案机制现有四 IPC（`flow:saveProposal/loadProposal/applyProposal/discardProposal`，[src/main.ts:2252-2376](../../../src/main.ts)）已实现单槽 `artifacts/<id>/proposal.json`、baseVersion 校验、生效前历史快照（`writeFlowHistorySnapshot`）与 version+1 落盘——pending 机制的存储与决议内核**可直接复用**，需要换的是渲染层消费方式（对比视图 → AI 面板 Confirm/Discard）与措辞。聊天触发现由 `aiRequestNeedsMaterial` 正则把门（[renderer/app.js:6013](../../../renderer/app.js)）、来源沿用粘性 `aiSourceIds`（app.js:6136 等）——两者移除。接管修复对 Refined 目标现走 saveProposal（[renderer/bridge.js:1541](../../../renderer/bridge.js)）——改为直落盘。`computeProposalDiff`/`proposalStepSignature`（app.js:6712-6780）承担过图形对比的 diff 计算——保留复用为变更清单文本生成。

## Goals / Non-Goals

**Goals**：pending 机制的存储/决议内核复用而非重写；意图判定零额外模型调用（并入 advice）；来源选择每条消息显式求值；传输失败可操作化。
**Non-Goals**（除 proposal Out-of-Scope 外的设计边界）：不动 `src/ai-refine.ts` 生成管线本体；不动 `flow:updateSteps` 手工编辑链路；不动回放/Test。

## Decisions

1. **Pending 存储 = 现 proposal.json 槽位改名**：文件 `artifacts/<id>/proposal.json` → `pending.json`，四 IPC 改名 `flow:stagePending/loadPending/confirmPending/discardPending`；`FlowProposal` 类型改 `FlowPending`（字段不变：version/createdAt/source/flow/summary/risks/baseVersion）。决议内核（baseVersion 校验 → `writeFlowHistorySnapshot` → version+1 `parseFlow` 落盘 → 删文件 → patchRecording 清 `pendingProposal` 标记）原样保留，元数据字段同步改名 `pendingUpdate`。理由：行为内核已验证，改名让语义诚实；同仓同步改无兼容负担。备选（全新内存态 + 序列化落盘）因重启存活需求而多余，弃。
2. **Confirm / Discard 入口在 AI 面板快捷动作条**：符合 renderer-ui 既有契约"所有可点动作都在快捷条"。存在未决议 pending 时快捷条出现 Confirm / Discard 按钮（带来源摘要 tooltip）；聊天里生成消息只附变更清单文本（不内嵌按钮，避免消息级交互件）。生成成功消息文案改为"已生成待确认的新版本 v(N+1)，确认后生效"。
3. **变更清单由渲染层复用 diff 函数生成**：pending 保存成功后，渲染层用 `computeProposalDiff(currentFlow, pendingFlow)` + `proposalStepSignature` 把 added/removed/changed/groupAdded/groupRemoved/groupChanged 映射为中文文本清单（步骤用 label，组用组名，网关/分支变化按 condition 步骤的增删改单列），`appendAIMessage` 呈现。备选（主进程再实现一份 diff）重复实现，弃。对比视图渲染代码（`fillProposalCompareView`/`renderProposalGraphWorld`/`hydrateProcessProposal` 的对比分支及 index.html 对比模板、app.css proposal 样式，约 300 行）删除；`computeProposalDiff` 保留。
4. **意图判定用行级标记而非 JSON 化回复**：`config/prompts.json` 的 `advice.prompt` 增加要求——回复正文之后另起一行输出 `INTENT=refine` 或 `INTENT=advice`（refine = 用户希望生成/更新可回放的工作流版本）。渲染层以行级正则提取并从展示文本中剥离该行；提取失败按 advice 呈现，且**由渲染层固定追加**一句兜底提示（"如需我直接生成新版本，请明确说明或使用 Refine 表单"）堵死循环。备选（整个回复 JSON 化）破坏 advice 的自然语言契约与解析稳健性，弃。systemPrompt 不动（契约只加在 advice 模板尾部，生成链路不受影响）。
5. **来源求值每条消息重算，删除 `aiSourceIds`**：`invokeAIMerge` 的来源改为显式链：@ 附件（`aiAttachmentItems`）> `currentAssistantItem()`（当前打开）> 列名询问（AI 消息列出当前任务全部已存录制名，请用户 @ 回复；任务内无录制则直接告知无可细化对象）。`state.aiSourceIds` 的全部读写删除；Refine 表单标题计数改用提交时显式源。Refine 按钮/表单路径（`forceMaterial`）保持必定生成，来源 = `summarizeRecordings` 打开菜单时的勾选快照（现状 `chosen`，不经意图判定）。
6. **repair 直落盘复用决议内核**：从 `confirmPending` 内核抽出 `persistFlowUpdate(recording, flow, source, summary)`（快照 + version+1 + 落盘）；新增 IPC `flow:directUpdate`（repair 专用，参数含 taskCode/recordingId/flow/summary），bridge.js 的 `item.summary` 分支由 saveProposal 改调它；Record 目标的 REPAIRED- 分支不动。`source` 记 `'takeover-repair'` 供快照溯源。
7. **传输重试在 `runPiPrompt` 内做一次**：失败文本命中传输类特征（`other side closed`/`socket hang up`/`ECONNRESET`/`ECONNREFUSED`/`fetch failed` 且非超时）→ 间隔 1s 重发同一 prompt 一次；仍失败返回错误文案（中文）："模型请求在传输层被中断（常见原因：本地代理空闲超时约 30s 掐断长请求）。请调大代理 idle/response 超时（建议 ≥300s）或重试。"超时（Timeout）不重试。理由：重试收敛在请求层、不波及 worker 生命周期；一次上限防雪崩。
8. **意图=refine 后的调用时序**：advice 调用返回 → 渲染层解析 INTENT → refine 时剥离标记后先落一条"正在生成…"消息，再调 `pi:generateFlow`（第二次模型调用）。两段串行延迟由 design 接受（advice 本就要发生）；生成默认 180s 超时不变。

## Risks / Trade-offs

- [模型不输出 INTENT 标记或措辞漂移] → 回退 advice + 渲染层固定兜底提示句，用户永远有下一步可走；真机验证项覆盖。
- [两次模型调用串行，总延迟上升且都受 32s 代理问题影响] → 决策 7 的重试与文案缓解；代理侧调优属用户环境（proposal Out-of-Scope 已声明）。
- [pending 被新 refine 静默覆盖，旧版无快照可回] → 设计如此（用户确认）；覆盖消息中的变更清单是唯一留痕，文案中注明"已覆盖上一版未确认修改"。
- [删除对比视图约 300 行属破坏性删除] → 回滚 = revert；diff 函数保留降低清单文本的回归风险。
- [advice prompt 变更影响全部 advice 场景（含 replay-failure 预设）] → 标记为尾部单行、剥离后呈现，行为对既有场景透明；真机验证项覆盖失败回放建议路径。

## Migration Plan

无数据迁移：`pending.json` 是新文件；残留 `proposal.json`（当前无存量）按无 pending 忽略不读。任务元数据 `pendingProposal` 标记字段随 IPC 改名为 `pendingUpdate`（无外部消费方）。回滚 = revert 全部改动。

## Open Questions

（无——pending 生命周期、覆盖语义、可见性、repair 直落、意图判定方式、来源优先级、询问形态、冲突处理均已在规划会话与用户逐项确认。）
