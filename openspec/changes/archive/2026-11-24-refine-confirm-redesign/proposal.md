# Proposal

## Why

真机验证暴露 Refine 链路三处断裂：聊天里的生成意图被窄正则把门（`aiRequestNeedsMaterial` 对常见中英文措辞大面积漏判，落入 advice 后又被告知"不得生成"，形成死循环）；生成来源沿用粘性 `aiSourceIds`（上一次 AI 操作的对象被静默沿用，用户勾选被忽略，导致"细化原始记录却产出无变化版本"）；完整生成请求（约 30k 字符 prompt）经本地代理在 ~32s 被掐断（"other side closed"），即使意图命中也灭在调用阶段。同时既有的"并排对比面板 + Apply/Discard"提案制验证成本高，用户确认了新的交互范式：内存（临时盘）暂存 + AI 面板 Confirm。

## What Changes

- **BREAKING**：删除 Process 标签页的并排对比提案视图与 `flow:saveProposal/loadProposal/applyProposal/discardProposal` 现语义，改造为 pending 机制——唯一来源是单个 Refined 记录时，生成结果写 `artifacts/<recordingId>/` 下的 pending 临时文件（非正式版本），AI 面板出现 **Confirm / Discard** 双快捷按钮。
- **演进规则**：Refine 一条 Record → 每次生成新的 Refined 条目（多次并立）；唯一源是单个 Refined → 原地迭代（Confirm 落盘 version+1 + 自动历史快照）；任何多源组合（Record+X、Refined+Refined）→ 生成新的合并 Refined 条目。
- **Pending 生命周期**：落临时盘（重启后仍可 Confirm/Discard）；Discard 立即删除文件；已有 pending 时新 refine 直接覆盖不询问；Confirm 时校验 baseVersion，正式版已变（pending 期间有手工编辑落盘）则拒绝并提示重新生成。
- **变更可见性**：Confirm 前 AI 消息附结构化变更清单（新增/删除/修改步骤、分组调整、网关变化，带步骤名；由现有 `computeProposalDiff` 生成文本），不再提供图形对比。
- **历史版本**：Confirm 落盘自动写历史快照（复用 `writeFlowHistorySnapshot`），本轮只存不展示。
- **takeover-repair 直接落盘**：接管后自动修复对 Refined 目标不再走 pending/对比，直接 version+1 落盘（历史快照兜底回滚）；对 Record 目标维持 REPAIRED- 新条目现状。
- **触发判定**：勾选 + 点 Refine 按钮 → 必定 refine，绕过一切判定；聊天 → 意图分析**并入 advice 调用**（advice 模型返回带 intent 标注的 JSON；解析失败回退纯文本 advice），识别为 refine 后来源匹配：**@ 引用 > 当前打开的工作流 > 都没有则 AI 列出候选名称、用户 @ 回复**。移除 `aiRequestNeedsMaterial` 正则与粘性 `aiSourceIds` 的来源求值。
- **传输层缓解**：`runPiPrompt` 识别传输类失败（other side closed / socket hang up / fetch failed），给出可操作错误文案（指向代理空闲超时）并自动重试一次。

## Capabilities

### New Capabilities

- `refine-lifecycle`：Refine 演进契约——Record/多源 → 新 Refined 条目；单 Refined 源原地迭代的 pending 暂存与 Confirm/Discard 决议、baseVersion 冲突拒绝、Confirm 自动历史快照、takeover-repair 的直接落盘。

### Modified Capabilities

- `ai-integration`：advice 提示词新增结构化 intent JSON 契约（含解析失败回退）；Pi worker 传输类失败的识别、单次自动重试与可操作错误文案。
- `renderer-ui`：AI 面板——删除并排对比提案视图；新增 pending Confirm/Discard 快捷方式与聊天内结构化变更清单；聊天触发的来源匹配优先级（@ 引用 > 当前打开 > 列名询问）；移除意图正则与粘性来源。

## Impact

- 主进程：`src/main.ts`（proposal 四 IPC 改造为 pending 语义 + repair 直接落盘分流 + 变更清单文本生成入口）、`src/pi-agent.ts`（传输错误识别/重试）、`src/prompts.ts`（advice 模板校验不变，模板内容在 `config/prompts.json` 更新）。
- 渲染层：`renderer/app.js`（invokeAIMerge 来源求值重写、意图消费、Confirm/Discard UI、删除 `fillProposalCompareView` 等对比视图约 300 行）、`renderer/bridge.js`（repair 分流改直接落盘）、`renderer/index.html`（对比视图模板删除、AI 面板按钮模板）。
- 数据：pending 文件为新增临时产物；既有未决议 `proposal.json`（当前无存量）不迁移，按无 pending 处理。
- 兼容：无 Flow schema 变更；IPC 通道语义变更为 BREAKING（渲染/主进程同仓同步改，无外部调用方）。

## Out-of-Scope

- 历史版本的查看/回滚 UI（快照只存不展示；后续另立 change）。
- 画布级 pending 预览（只读渲染待确认版本）等任何图形对比替代物。
- 代理空闲超时的外部调优（属用户环境配置；本 change 只做应用侧识别/重试/文案与文档指引）。
- auto-refine（录制后自动孪生）与停录后 AI 交互行为的再改动。
- Test/接管链路除 repair 落盘分流外的任何改动。
- 生成模板（refine/autoSanitize）内容与登录网关指引的调整（round5 已定稿）。
