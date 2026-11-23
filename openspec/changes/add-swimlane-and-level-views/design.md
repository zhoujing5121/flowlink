# Design

## Context

前置：`refactor-process-canvas-x6` 提供 X6 渲染基座（HTML 节点、容器、边 vertices、pan/zoom/fit）；`add-multilevel-grouping` 提供嵌套分组、`targetSystem` 标签、层级编号。目标交互以 `ui_prototype/FlowLink.11.20.html` 为准（泳道列=系统、行=阶段、任务卡+Expand、Flow/Swimlane 菜单、编号图例）。demo 的 lane 分配是硬编码示例，真实数据由 targetSystem 标签与祖先继承推导。

## Goals / Non-Goals

**Goals:**

- Flow | Swimlane 双视图 + 级别切换 + Expand 开关，交互形态对齐 demo。
- 泳道与级别视图均为纯视图状态（不落盘、不改数据）。
- 回放 overlay 在两视图、各级别下实时正确。

**Non-Goals:**

- userRole/角色纵轴、维度切换（proposal Out of Scope）。
- 拖拽编辑泳道/节点位置。
- 泳道列的自动排序/聚合配置（列按出现序）。

## Decisions

### D1 视图与级别状态机

- Process 面板状态：`view: 'flow' | 'swimlane'`、`level: 1..maxDepth`（flow 视图有效）、`expanded: boolean`（Expand）。三者正交；存于 item 的 UI 状态（与 demo `item.processView` 同位），不进 Flow JSON。
- 级别切换器 = 编号图例位置的可点击段（`01_Activity / 01-01_Task / 01-01-01_Action`），枚举实际深度；>3 级自然延伸第四段。

### D2 级别视图与边聚合

- 数据推导放进 `renderer/flow-graph.js`：`buildGraph(flow, {level})` 按级别裁剪树——节点 = 深度 ≤ level 的分组卡（level 处的分组为叶子卡），下钻 = 对单子树设 level+1 并聚焦；布局继续 dagre（节点集合变了，坐标重算）。
- 边聚合：下一级图上的顺序/分支/回跳边，端点提升到各自最近的 level 级祖先节点；同对节点间平行边合并保留分支标签；回跳判定按提升后端点序比较。
- 扁平数据：深度只有两级，切换器隐藏 L1、默认 L2——与现状视图等价。

### D3 泳道布局

- `flow-graph.js` 新增 `buildSwimlane(flow)` 纯数据推导：列 = Flow 内 targetSystem 去重（出现序）+「未标注」；行 = L1 组（顶层组）；分支兄弟 L1（同一 condition 的 true/false 目标所在组）合并为一条带（带标题「03–05 并行提交审核」式）；节点 = L2 组卡（扁平数据 = 步骤卡），lane = 节点有效 targetSystem（自身标签，缺省继承最近祖先 L1 标签，仍缺 → 未标注列）。
- 坐标自算网格（不走 dagre）：列宽按列头文本与卡内容实测、行高按带内最大卡高；demo 的绝对定位算法可参考复刻。
- X6 呈现：列头/阶段带 = 画布背景层或 HTML 覆层；任务卡 = HTML 节点；连线 = 顺序边（分支边带标签）。

### D4 Expand/Collapse 与两视图

- 开关展开「卡片主体的下一级明细行」：L1 卡展开 L2 行、L2 卡展开步骤行、扁平步骤卡展开说明明细（demo 的 action 明细同款）；与级别切换正交（Expand 是卡内行，级别切换是节点粒度）。

### D5 overlay 适配

- 聚合状态函数 `statusOf(node, results)`：按节点子孙步骤聚合（任一 fail=红、全 skip=灰、否则绿/进行中）；flow 视图按当前 level 节点、泳道按任务卡与连线渲染；对齐仍走 flattenFlowSteps 的扁平 stepId（不变）。

## Risks / Trade-offs

- [级别切换 + 下钻 + 泳道的状态组合爆炸] → 状态机只有三个正交布尔/枚举；视图切换重置下钻焦点。
- [边聚合后平行边/回跳判定语义模糊] → 聚合规则在 design 层固定（提升到最近祖先 + 平行边合并），永久 node:test 覆盖纯数据推导（buildGraph(level) 与 buildSwimlane 均为纯函数）。
- [泳道未标注/单列流程观感差] → 未标注列兜底不隐藏；全无标签时泳道退化为单列纵向流（仍可用）。
- [demo 与真实数据粒度差异（demo 三层实为两级+明细）] → 粒度映射已定（行=顶层组、节点=次级单元、Expand=明细），实现以真实嵌套数据为准。

## Migration Plan

纯渲染层新增，无数据迁移；回滚 = git revert。

## Open Questions

（无——泳道列宽/行高的视觉参数实现时按 demo 校准。）
