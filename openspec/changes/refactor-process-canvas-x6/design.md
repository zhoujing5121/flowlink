# Design

## Context

自研画布结构（见 `renderer/flow-graph.js` 头注释与 `docs/architecture.md`）：纯数据层（flatten/buildGraph/layoutGraph）已与渲染解耦，dagre 布局坐标由 `layoutGraph` 计算写入节点对象；`renderer/app.js` 负责把坐标画成绝对定位卡片 + SVG 边层 + 手写 pan/zoom/fit。渲染层无打包器，第三方依赖只能经 `src/renderer-vendor.ts` 全局变量进入（dagre、rrweb 先例，CSS 随 `dist/renderer-vendor.css`）。

选型结论（2026-11-22 与用户确认）：**AntV X6 3.x**。叠加泳道需求后优势明确——parent/child 容器机制同时覆盖后续的嵌套分组与泳道列，HTML 自定义节点承载富任务卡。备选 maxGraph（原生 swimlane 图形但富 HTML 卡弱）、LogicFlow（分组折叠已知问题）已在讨论中排除。用户确认不计包体积。

## Goals / Non-Goals

**Goals:**

- X6 承载 Process 画布全部渲染与视图交互（pan/zoom/fit/minimap），行为与现状逐项对等。
- 数据层零改动：X6 消费 `flow-graph.js` 产出的 `{nodes, edges, 坐标}`。
- vendor 接入与 dagre/rrweb 模式一致，缺失时显式报错。

**Non-Goals:**

- 不改任何用户可见行为（布局、样式、交互语义对等即可，像素级一致性不追求）。
- 不启用 X6 编辑能力（节点拖动改结构、连线编辑）——画布是审阅视图。
- 不做嵌套分组、级别切换、泳道（后续 change）。

## Decisions

### D1 渲染映射

- 分组卡/未分组伪组卡 = X6 HTML 自定义节点（`registerNode` + HTML markup），复用现有卡片 DOM 结构与 CSS；卡片尺寸仍布局前实测（`layoutGraph(measure)` 机制不变）。
- Start/End 哨节点、菱形判定节点 = X6 shape 节点（HTML 或 path 节点均可，选实现最省者）。
- 边 = X6 edge，`vertices` 吃 `layoutGraph` 算好的 dagre 折线路由点；样式映射：flow=实线、branch=带「是/否」标签、back=虚线。不做 X6 自动路由。
- 坐标：`layoutGraph` 产出 `left/top/width/height`，直接 `setPosition`/`resize`，pan/zoom/fit 用 X6 自带（替换手写 world transform）。

### D2 交互迁移

- 点击选中、步骤右键菜单、分组菜单（`getBoundingClientRect` 定位逻辑保留，挂到 X6 节点事件）、分支徽章、条件样式——全部由 X6 事件桥接回现有处理函数，菜单内容与行为不变。
- 回放 overlay：X6 节点/边 class 切换驱动现有样式（绿/红/灰描边、走过高亮、未走变暗），对齐逻辑（flattenFlowSteps + stepId）不变。
- Refine 并排对比：两画布实例复用同一渲染函数。
- minimap：X6 官方插件（现状没有小地图，属新增便利功能——注意：这是本 change 唯一的新增可见能力，随引擎自带，无行为契约影响）。

### D3 spike 验证与回退

Electron 45（打包链路 win32 x64）实测清单：嵌套容器节点、折叠/展开、HTML 节点事件冒泡（右键/点击）、边 vertices+labels、样式随 vendor CSS 打包、esbuild 打包 X6 无 SSR/Node 依赖问题。阻塞级失败 → 回退 maxGraph 重评（本 change proposal 修订，不影响 B/C 的 spec 契约）。

### D4 删除范围

app.js 内自研渲染胶水（SVG 边层绘制、world transform、pan/zoom、fit、尺寸量测编排）删除；`flow-graph.js` 保留全部三个导出。dagre vendor 全局保留（布局仍在用）。

## Risks / Trade-offs

- [X6 3.x 与 2.x 文档/示例混杂] → spike 清单先行；实现固定在锁定版本，升级需新 change。
- [HTML 节点内右键/点击与 X6 画布事件冲突] → spike 项覆盖；冲突时用事件透传或 `stopPropagation` 收敛。
- [对等回归面大] → 以现有 renderer-ui spec 场景为逐项验收清单（vendor 缺失报错、并行链着色、分支边样式、overlay 实时性、对比视图）。
- [vendor 体积增长（用户已确认不计）] → 记录体积数字于 CHANGELOG。

## Migration Plan

一次性替换，无数据迁移、无运行时开关；回滚 = git revert。旧渲染代码不留双路径。

## Open Questions

（无——库已锁定、行为对等基准明确；X6 插件按需引入的具体清单在实现时定。）
