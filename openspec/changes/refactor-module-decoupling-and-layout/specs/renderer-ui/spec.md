# Spec Delta

## MODIFIED Requirements

### Requirement: The Process tab SHALL render the flow as a semantic graph

The Process tab SHALL lay the flow out as a directed graph whose nodes and edges follow execution semantics, with no serial-list fallback, and SHALL render nested group levels as hierarchical nodes.

画布由 vendored 图引擎依赖承载（经 `dist/renderer-vendor.js` 全局变量进入，先于界面模块加载；缺失时显示明确错误而非空白画布）。Process 工具栏提供 Flow | Swimlane 视图菜单（radio 语义）与 Expand/Collapse 动作详情开关（卡内展开下一级明细行）；两视图共享缩放/fit 控件，视图选择为 UI 状态不落盘。节点层级：L1 业务级分组、L2 技术级分组（现有 group）、L3 步骤详情；嵌套分组以层级节点呈现（内层组卡位于其外层组内）；未分组步骤仍以伪组呈现。既有交互保留：分支徽章、条件样式、点击选中、步骤右键、分组菜单（`getBoundingClientRect` 定位）；实线顺序边、标注是/否的条件边、虚线回跳边；组尾条件步骤抽出为菱形判定节点；卡片尺寸布局前实测、世界尺寸驱动 pan/zoom `fit()`。

#### Scenario: vendor 缺失
- **WHEN** dist/renderer-vendor.js 加载失败
- **THEN** Process 面板显示明确错误信息而非空白画布

#### Scenario: 嵌套分组渲染
- **WHEN** 打开一个含 L1/L2 两层嵌套分组的 Flow
- **THEN** 画布按层级呈现分组节点（L2 节点位于其 L1 内），边仍按执行语义连接

#### Scenario: 视图切换
- **WHEN** 用户在工具栏从 Flow 切换到 Swimlane
- **THEN** 画布切换为泳道布局，缩放/fit 与 Expand 开关状态保持

### Requirement: Step flattening and event alignment SHALL have a single shared implementation

Step flattening and playback event alignment SHALL come from one shared implementation used by the Test list, the Process graph, and all playback event handlers.

`renderer/panels/process/graph/flatten.js` 的 `flattenFlowSteps` 是唯一扁平化实现（步骤 id 带分组前缀，与 `engine/executor/src/steps.ts` 一致）；`playback:step`/`done`/`aiStep` 事件按其对齐（`aiStep` 现带 `stepId`，`stepIndex` 为旧回退），显示顺序与结果对齐不会漂移。运行未达的步骤显示 Pending、引擎跳过的显示灰色 Skipped；AI 完成的步骤带 AI 徽章。

#### Scenario: 分支跳过不串行
- **WHEN** 条件跳转越过多步
- **THEN** 被跳过步骤显示灰色 Skipped，后续结果按 id 对齐到正确行
