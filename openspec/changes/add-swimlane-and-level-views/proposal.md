# Proposal

## Why

多级分组数据（`add-multilevel-grouping`）落地后，画布需要一个跨层级浏览与二维组织的呈现层：用户要能在 L1 业务级 / L2 技术级 / L3 详情级之间切换查看（分级切换是原始需求），并需要按「目标系统 × 业务阶段」组织的泳道视图审视流程（目标交互以 `ui_prototype/FlowLink.11.20.html` demo 为准：Flow | Swimlane 双视图切换、Expend/Collapse 动作详情开关、01_Activity / 01-01_Task / 01-01-01_Action 编号图例、系统泳道列 + 阶段行 + 任务卡）。

## What Changes

- **Flow | Swimlane 双视图切换**：Process 工具栏新增视图菜单（Flow / Swimlane radio），两视图共享缩放/fit 控件与 Expend/Collapse 动作详情开关（卡内展开下一级明细行，demo 同款）。视图选择为 UI 状态不落盘。
- **级别切换器**：demo 的编号图例位置（`01_Activity / 01-01_Task / 01-01-01_Action`）做成可点击的级别切换器，Flow 视图按所选级别切换「卡片主体」粒度（L1/L2/L3…枚举 Flow 内实际深度）；双击分组节点下钻一级、面包屑返回；L1/L2 级别的边由下一级顺序/分支边聚合而来（保留实线/条件/回跳样式）。
- **泳道视图**：列 = targetSystem（Flow 内去重值 + 「未标注」兜底列）、行 = L1 业务阶段（左侧阶段带；条件分支的兄弟 L1 组合并为一条阶段带并加分支标题，demo「03–05 并行提交审核」同款）、节点 = 下一级任务卡（嵌套数据为 L2 组卡、扁平数据为步骤卡；Expend 展开卡内明细）、箭头按执行顺序跨列连接、Start/End 端点。
- **回放 overlay 适配**：Flow 视图按当前级别聚合着色（任一子孙失败即红、全跳过即灰）；泳道视图节点/边同步实时状态。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `renderer-ui`：
  - 「Process 标签页渲染语义图」requirement：增加 Flow/Swimlane 双视图切换与 Expend/Collapse 开关。
  - 新增「级别切换查看」requirement（L1/L2/L3… 粒度切换、下钻/返回、边聚合、扁平数据默认最高可得级别）。
  - 新增「泳道视图按系统×阶段布局」requirement（列/行/节点/阶段带/未标注列/连线语义）。
  - 「回放 overlay 实时叠加」requirement：增加按当前级别的状态聚合与泳道视图 overlay。

## Impact

- `renderer/app.js`（视图状态机、级别切换、泳道布局推导与渲染、工具栏）、`renderer/flow-graph.js`（泳道布局纯数据推导：lane 分配、阶段带、聚合边）、`renderer/index.html`（工具栏与泳道模板）、`renderer/app.css`。
- 消费 `add-multilevel-grouping` 的 targetSystem 标签与嵌套结构；无 schema/engine/AI 改动。
- 依赖顺序：在 `refactor-process-canvas-x6` 与 `add-multilevel-grouping` 之后执行。

## Out of Scope

- userRole 维度与角色纵轴（纵向 role 泳道将来需要时另立 change）。
- 泳道纵向维度切换（阶段 | 角色）与自定义维度。
- 画布内拖拽调整泳道/节点位置、自由编排。
- 语义布局算法更换（Flow 视图保留 dagre 布局）。
- 数据模型、AI 契约、执行器（已在 `add-multilevel-grouping` 定型）。
