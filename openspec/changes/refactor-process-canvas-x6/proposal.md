# Proposal

## Why

Process 画布是自研实现（`renderer/flow-graph.js` 纯数据图模型 + `renderer/app.js` 手写 SVG 渲染/平移缩放 + dagre 布局），维护成本高、功能扩展受限。后续的多级分组、级别切换与泳道视图（`add-multilevel-grouping`、`add-swimlane-and-level-views`）都需要一个成熟的图编辑引擎承载，自研画布已成为阻塞。本 change 先完成引擎替换并保持行为完全对等，为后续能力打地基。

## What Changes

- **引擎替换**：Process 画布渲染层从自研 SVG + 手写 pan/zoom 迁移到 **AntV X6 3.x**（MIT、原生 JS 无框架依赖、父子容器节点、HTML 自定义节点、官方 scroller/minimap 插件；选型经 2026-11-22 讨论确认，备选 maxGraph 见 design.md）。
- **vendor 接入**：X6 经 `src/renderer-vendor.ts` 以全局变量（`window.__flowlinkX6`）进入渲染层，与 dagre/rrweb 同模式；样式随 `dist/renderer-vendor.css` 产出。
- **数据层保留**：`renderer/flow-graph.js` 的 `flattenFlowSteps` / `buildGraph` / `layoutGraph`（含 dagre 布局）原样保留，X6 只消费其产出的节点/边/坐标——纯数据推导与渲染解耦的既有结构不变。
- **行为完全对等（零 spec delta）**：语义图布局、sourceFlowId 分段并行链与 `meta.sourceFlows` 着色图例、分支/回跳边样式、菱形判定节点、回放实时 overlay、右键菜单与分组菜单、Refine 前后并排对比、vendor 缺失显式报错——全部保持现有行为，以现有 renderer-ui spec 场景为逐项验收清单。
- **多级分组与泳道不在本 change**：画布仍按现有两级数据（顶层 group → step）渲染；嵌套分组、级别切换、泳道视图由后续 change 实现。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——纯实现替换，行为契约不变，`skip_specs: true`。）

## Impact

- `package.json`（新增 `@antv/x6` 依赖）、`src/renderer-vendor.ts`（导出全局变量与样式）、`build.mjs`（vendor 打包如有 CSS 钩子调整）。
- `renderer/app.js`：删除自研 SVG 渲染/pan/zoom/fit 胶水，改为 X6 画布搭建与节点/边注册（约千行渲染代码重写为库调用）。
- `renderer/index.html`、`renderer/app.css`：画布容器与样式适配。
- `renderer/flow-graph.js`：不改（数据层保留）。
- 不改 engine、schema、IPC、执行语义。

## Out of Scope

- 多级分组数据模型与 AI 输出（`add-multilevel-grouping`）。
- 级别切换器与泳道双视图（`add-swimlane-and-level-views`）。
- 任何行为变化（布局算法、边样式、交互语义均与现状对等）。
- 画布内自由编辑、拖拽连线改结构。
- minimap 以外的 X6 编辑插件（selection/snapline/clipboard 等按需留给后续 change）。
