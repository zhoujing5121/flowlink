# Proposal

## Why

第四轮 19 项实现落地后真机验证暴露四项遗留/回归：rrweb 回放在应用内仍黑屏（隔离 harness 已证明数据、Replayer、CSS 规则全部正常，剩余未知只在实际应用环境，需要应用内诊断事实）；Process 画布没有组右键菜单且步骤右键菜单定位错误/经常不出现；Refine 结果退化——登录网关重构指引被上一轮改写成条件性「保持」措辞，默认 Refine 不再生成 SSO 条件分支；录制结束后仍自动调用 AI 分析（应完全不自动）。

## What Changes

- **rrweb 回放：先诊断后修复**。Record 页新增「回放诊断」按钮：一键检查并展示可复制的诊断报告（vendor CSS 规则命中、iframe 尺寸/位置/computed 定位、事件数与段数、Replayer 元数据、stage/tab-view 布局值）；修复策略依据诊断事实落地（CSS 未命中→运行时内联注入完整 rrweb 样式；iframe 零尺寸→显式尺寸兜底；数据段缺失→加载链路检查），诊断按钮修复后保留。
- **Process 右键菜单**：新增**组右键菜单**（右键组卡任意处弹出：重命名/上移/下移/并入下一组/删除/重录该组/前后插入——与现有组操作按钮同源）；菜单定位改用画布坐标系换算（正确跟随 world 的平移与缩放）；**步骤右键菜单保留**并同步修复定位与触发（组卡空白处不再被吞掉）。
- **Refine 登录网关指引修复**：`config/prompts.json` 的 generation.refine/autoSanitize 与 systemPrompt 恢复**无条件主动**的登录段重构指引（按现行契约表述：入口导航 → 网关 condition（`trueStepId` 指向凭据段之后的首个业务步骤，分支缺省=顺序继续）→ isOptional 容忍凭据步骤 → 目标页断言收尾，全部位于首个业务阶段组内）——默认 Refine（不含登录措辞的指令）也必须执行该重构。
- **停录后完全不自动 AI 交互**：删除录制结束后的自动 AI 分析调用（bridge.js 两处 `recording-complete`），AI 面板也不再自动打开；用户需要 AI 时自行打开面板。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `renderer-ui`: Record 回放需求补充「应用内完整渲染 + 回放诊断」；AI 面板需求补充「录制结束后无任何自动 AI 交互」；新增组右键菜单与右键定位需求。
- `ai-integration`: 生成提示词的分组/网关不变量修正——登录段无条件主动重构（兼容并覆盖 round4 未归档 delta 对同一需求的修改）。

## Impact

- 代码：`renderer/app.js|app.css|index.html`（诊断按钮、右键菜单、停录自动交互移除）、`config/prompts.json`（指引恢复）。
- 兼容：无 schema/数据变更。
- 参考：`docs/archive/`（round4 已归档计划如有）、`scratch-rrweb-debug/`（harness 证据）。
- 验证：build + tsc；黑屏诊断需真机配合一次（把诊断报告发回）；Refine 需真机跑一次确认 SSO 分支生成。

## Out-of-Scope

- Test 自动执行/AI 接管的任何改动与验证（用户明确：等 Refine 效果优化后再测）。
- rrweb 播放器的整体重构（若诊断报告指向深层环境问题，另立 change）。
- Process 连线着色、Instruction 重构（用户既定后续项）。
