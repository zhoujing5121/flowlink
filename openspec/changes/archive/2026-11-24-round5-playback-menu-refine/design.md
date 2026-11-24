# Design

## Context

见 proposal.md。取证事实：harness（vendor.css + 应用防御规则 + 多段真实数据）渲染完全正常——黑屏根因只能在应用内环境（Electron renderer 特性或 mountRrwebPlayer 应用侧逻辑），修复前需应用内诊断事实。Process 画布 = canvas > world（`transform: translate+scale`），现有步骤菜单用视口坐标差定位（变换下错位），组菜单不存在。refine 模板登录段指引被 round4 改成条件性「保持」措辞（`If the instruction touches the login segment, keep...`），默认指令下模型无从保持、不生成网关。停录自动 advice 调用在 `renderer/bridge.js` 两处（~598 fallback 路径、~679 正常路径）。

## Goals / Non-Goals

Goals：拿到黑屏的应用内事实并据此修复；右键菜单完整可用；默认 Refine 必然产出 SSO 网关结构；停录后零自动 AI 交互。
Non-Goals：播放器整体重构（诊断若指向深层问题另立 change）；Test/接管链路（用户暂缓）；连线着色与 Instruction 重构。

## Decisions

1. **黑屏两步走（诊断→修复）**：第一步只加「回放诊断」按钮（renderer/app.js + 模板），报告采集：`getComputedStyle` 检查 `.replayer-mouse-tail`/`.replayer-wrapper`/iframe 的 position 与尺寸、vendor 样式表加载状态（`document.styleSheets` 里 rrweb 规则计数）、`mountRrwebPlayer` 会话的 events 段数/Replayer meta、stage 与 tab-view 的 clientWidth/Height；一键复制。第二步按报告落修复——预置三类修复路径（CSS 未命中→播放器挂载时运行时注入完整 rrweb 基础样式为内联 `<style>`；iframe 零尺寸/错位→显式 width/height 与定位兜底；数据段缺失→`recording:loadRrweb` 链路检查），执行会话按实际报告选择实施，避免再盲修。真机流程：用户点诊断→复制报告发回→按报告修→用户复验。
2. **右键菜单**：菜单继续作为 canvas 的子元素绝对定位，定位改为 `(clientX - canvasRect.left)` 基础上**扣除 canvas 自身及祖先的变换影响**——实现上直接用 `canvas.getBoundingClientRect()` 的视觉框换算（现状）但菜单以 `position: fixed` + 视口坐标定位（`left/top = clientX/clientY`），彻底规避画布坐标系换算；新组菜单 DOM 复用步骤菜单的弹层样式与关闭逻辑（点击外/Esc 关闭），菜单项复用现有组操作函数（renameProcessGroup/moveProcessGroup/merge/delete/beginGroupRecording/插入）。右键分发：`e.target.closest('[data-canvas-group]')` 且非步骤行 → 组菜单；`.canvas-step` → 步骤菜单；空白 → 不弹。步骤菜单同步改 fixed 定位修复缩放平移错位。
3. **Refine 指引恢复**：refine/autoSanitize 模板把登录段从「If the instruction touches… keep the merged structure」改回无条件段落「**Restructure the authentication segment (always)**」：入口导航 → 网关 condition（`trueStepId` = 凭据段后首个业务步骤；缺省分支顺序继续）→ isOptional 凭据 → 目标页断言（timeout 15000），全部并入首个业务阶段组；systemPrompt 的 condition 契约段同步保持一致。不改 schema/引擎（round4 已就位）。
4. **停录零自动**：删除 bridge.js 两处 `startFlowLinkAIAdvice({mode:'recording-complete'…})` 调用；排查停录路径上其它 `aiOpen`/自动展开逻辑（`state.aiOpen` 置位、`renderAIPanel` 自动打开）一并移除；分组重录结束路径如有同款调用同样处理。预设项（用户手点）不受影响。

## Risks / Trade-offs

- [黑屏可能一步诊断不够（报告指向环境深层差异）] → 诊断报告项覆盖已知分叉；若仍不明确，第二轮按报告加针对性探针（另立小 change），不阻塞其它三项。
- [菜单 fixed 定位在窗口滚动/面板布局下仍需夹取边界] → 用 viewport 夹取（`Math.min(innerWidth-width…)`）。
- [提示词恢复后模型仍可能偶发不生成网关] → 任务含真机验证一次默认 Refine；若仍退化，考虑在 rehydrate 后做确定性后处理（检测无网关的登录段自动补）——记为备选，不在本 change。

## Migration Plan

无数据/schema 变更；回滚 = revert。

## Open Questions

（无——诊断报告回来前不预设黑屏修法，已按分叉预置三类路径）
