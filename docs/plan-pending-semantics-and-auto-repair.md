# 计划：失败后状态语义修正（保持 Pending）+ AI 接管后自动优化流程

日期：2026-11-16（第三轮）。前序：`docs/plan-process-flowchart-settle-quickbar-sourceflows.md`（已实现并提交 5fff2ed/d69b79d）+ 同日第二轮真机反馈修复（**当前在工作区未提交**，本计划在其上调整）。

**用户拍板的两项修正**（推翻第二轮的两处行为）：

1. **失败后保持 Pending**：回放中某步失败后，失败步骤之后的未执行步骤**全部保持 Pending**，不改写为 Skipped。语义划分：Pending = 未执行到（运行停止在失败处）；Skipped = 主动跳过（条件分支未走、isOptional 未生效）。AI 接管结束后未执行的步骤同样保持 Pending。
2. **接管后自动优化**：AI 接管执行完毕后**自动在后台**执行流程优化（pi:repairFlow 写回当前流程），不需要给用户按钮选择。

## 当前工作区状态（第二轮修复，未提交，本计划的调整基础）

第二轮已实现（**保留，不要回退**）：Break 真实拆组（app.js）、浏览器 bounds 渲染后强制重报（bridge.js 第 10 节）、菱形判断节点（flow-graph.js + app.js + app.css）、细化投影 BASE_FIELDS 补 execution/settle/sourceFlowId（ai-refine.ts）、pi:repairFlow IPC（main.ts）+ preload 暴露 + bridge 的 `window.aiRepairFlowAfterTakeover` 编排函数。

第二轮中**与本计划冲突、需要调整**的：bridge.js 三个事件处理器的"未执行→skip"兜底、#aiRepairFlow 按钮（index.html + app.js 绑定）。

## 变更 1：失败后未执行步骤保持 Pending

文件：`renderer/bridge.js`。三处调整，只动"无结果步骤"的落值方式，stepId 对齐等既有逻辑全部保留：

1. **`playback:done`**（约 1661-1674 行）：现逻辑"本次 run 没有结果的步骤统一置 `{status:'skip'}`"改为**不写该槽位**（`continue`，保持原状 Pending）。有最终结果的步骤（pass/fail/skip）照常覆盖。引擎分支跳过发出的 skip 事件与 stopOnFailure 停止后 done 的对齐互不影响：分支跳过的步骤在 result.steps 里有 skip 结果，正常覆盖为 Skipped；失败后未执行的步骤无结果，保持 Pending。
2. **`playback:aiDone`**：撤销本轮加入的"running/pending → skip"循环，恢复为只把 `running` 重置回 `pending`（接管结束、该步未完成）。**保留** `item.lastTakeover` 记录（变更 2 要用）。
3. **`playback:error`**：撤销本轮加入的"后续 pending/running → skip"循环，保留 running → fail 的既有行为。

连带检查（不改语义，只确认显示正确）：
- Test 列表（app.js `testProgressGroups`/`testGroupStatus`）：失败步骤之后的组整组 Pending、无 "Skipped · 分支未走" 淡化——确认组头在"全 pending"时不显示淡化样式即可（现状如此则不动）。
- Process 图回放态：无结果步骤/组 = 中性（无描边）——现状如此则不动；"未走分支边淡化"只依赖已落 skip 结果的分支目标，不受影响。

## 变更 2：AI 接管后自动后台优化流程

1. `renderer/index.html`：删除 `#aiRepairFlow` 按钮元素。
2. `renderer/app.js` `renderAIPanel`：删除 `#aiRepairFlow` 的显隐与 onclick 绑定段（含 else 分支里的 `hidden = true` 行）。
3. `renderer/bridge.js` `playback:aiDone`：在记录 `item.lastTakeover` 之后，若 `item.lastTakeover.aiCompleted > 0` 则**自动**触发 `void window.aiRepairFlowAfterTakeover(item)`（函数已存在，含 recordingId/testRunning/playbackInFlight 守卫与完整编排：调 `F.pi.repairFlow` → `F.flow.updateSteps` 写回 → `syncProcessFlowPresentation`/`rebuildItemTestFlow` → 聊天播报摘要）。追加防并发标记 `item.repairInFlight`：函数入口置位、finally 清除，避免重复触发；aiDone 侧也检查该标记。
4. 体验：自动优化开始/完成/失败都走聊天播报（函数内已有 appendAIMessage），不弹任何对话框；优化期间不阻塞用户操作（后台 Promise）。
5. 函数内的聊天文案首句从"Updating the flow…"保持不变即可（自动场景同样适用）。

## CHANGELOG 修正

- "### Fixed" 中第二条（Test: Steps after a failure stay pending forever…）整条改写为新语义：失败/接管结束/异常后未执行步骤保持 Pending（Skipped 仅表示分支未走与可选未生效）。
- "### Added" 中第二条（One-click "Update flow from AI takeover"…）改写为：接管完成后自动后台执行流程优化并写回当前录制（提及依据失败与接管证据、走 flow:updateSteps 校验、字段透传修复保留）。

## 验证

```powershell
node --check renderer/app.js
node --check renderer/bridge.js
npm run build
npx tsc --noEmit
```

真机场景（用户执行）：①回放一条会失败的流程——失败步之后全部保持 Pending（黄色），此前分支跳过的步骤仍为 Skipped；②失败后点 AI 接管——接管完成的步骤带 AI 徽标变绿，接管结束后剩余步骤保持 Pending，**无按钮**，聊天自动出现 "Updating the flow from the AI takeover result…" 并随后给出修复摘要，Process 图自动刷新为新结构。

## 边界与守则

- 不回退第二轮的其他修复（菱形判断节点、Break、bounds 强制重报、BASE_FIELDS、pi:repairFlow 主进程链路）。
- 工作区未提交改动之上继续编辑，不得 git checkout/restore/commit。
- 不运行测试套件；构建验证如上。
- UI 结构改动仅限删除按钮（index.html 模板区）。
