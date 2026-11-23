# Spec Delta

## MODIFIED Requirements

### Requirement: The Process tab SHALL render the flow as a semantic graph

The Process tab SHALL lay the flow out as a directed graph whose nodes and edges follow execution semantics, with no serial-list fallback, and SHALL render nested group levels as hierarchical nodes.

画布由 vendored 图引擎依赖承载（经 `dist/renderer-vendor.js` 全局变量进入，先于 app.js 加载；缺失时显示明确错误而非空白画布）。Process 工具栏提供 Flow | Swimlane 视图菜单（radio 语义）与 Expand/Collapse 动作详情开关（卡内展开下一级明细行）；两视图共享缩放/fit 控件，视图选择为 UI 状态不落盘。节点层级：L1 业务级分组、L2 技术级分组（现有 group）、L3 步骤详情；嵌套分组以层级节点呈现（内层组卡位于其外层组内）；未分组步骤仍以伪组呈现。既有交互保留：分支徽章、条件样式、点击选中、步骤右键、分组菜单（`getBoundingClientRect` 定位）；实线顺序边、标注是/否的条件边、虚线回跳边；组尾条件步骤抽出为菱形判定节点；卡片尺寸布局前实测、世界尺寸驱动 pan/zoom `fit()`。

#### Scenario: vendor 缺失
- **WHEN** dist/renderer-vendor.js 加载失败
- **THEN** Process 面板显示明确错误信息而非空白画布

#### Scenario: 嵌套分组渲染
- **WHEN** 打开一个含 L1/L2 两层嵌套分组的 Flow
- **THEN** 画布按层级呈现分组节点（L2 节点位于其 L1 内），边仍按执行语义连接

#### Scenario: 视图切换
- **WHEN** 用户在工具栏从 Flow 切换到 Swimlane
- **THEN** 画布切换为泳道布局，缩放/fit 与 Expand 开关状态保持

### Requirement: Replay state SHALL overlay the graph live while blocking edits

Replay state SHALL overlay the Process graph live (aligned by step id) while blocking edits during the run, with status aggregated at the currently viewed level.

步骤圆点与结果徽片、走过的边高亮、未走的分支边变暗；分组描边状态（绿=全过、红=有失败、灰=全跳过）在 L3 视图按所属组、在 L2/L1 视图按子孙步骤聚合计算——任一子孙有失败即红、全部跳过即灰；泳道视图的任务卡与连线同步实时状态；无论用户停在 Test 还是 Process 页签都实时刷新。多 `sourceFlowId` 的分组按 `meta.sourceFlows` 着色。

#### Scenario: 分支未走变暗
- **WHEN** 运行中某条件走了「是」分支
- **THEN** 该判定的「否」边变暗，各视图各层级分组描边随结果实时更新

#### Scenario: L1 级状态聚合
- **WHEN** 运行中某 L2 组内一步失败且当前处于 L1 视图
- **THEN** 该 L2 所属的 L1 节点描边变红

#### Scenario: 泳道实时状态
- **WHEN** 回放进行中且当前处于 Swimlane 视图
- **THEN** 正在执行的步骤所属任务卡高亮，未走的分支连线变暗

## ADDED Requirements

### Requirement: The Process tab SHALL switch viewing levels across hierarchical depths

The Process tab SHALL provide a level switcher enumerating the group depths present in the flow, plus per-node drill-down, and SHALL aggregate edges per level.

级别切换器（编号图例位置）枚举 Flow 内实际存在的层级深度（如 L1/L2/L3；扁平数据隐藏 L1、默认最高可得级别）；切换改变 Flow 视图「卡片主体」的粒度；双击分组节点下钻一级、面包屑返回上级；L1/L2 级别的边由下一级节点的顺序边与分支边聚合而来（保留实线/条件/回跳样式）。级别选择为 UI 状态不落盘。

#### Scenario: 级别切换
- **WHEN** 用户在 L1 视图点击切换到 L2
- **THEN** 画布以技术级分组为节点重排，组间边按 L3 顺序/分支边聚合呈现

#### Scenario: 节点下钻
- **WHEN** 用户在 L2 视图双击某技术级分组节点
- **THEN** 视图进入该组内部（L3 详情），出现返回上级的导航

#### Scenario: 扁平数据默认 L2
- **WHEN** 打开一个无嵌套分组的旧 Flow
- **THEN** 级别切换器不提供 L1，默认显示 L2 视图

### Requirement: The Swimlane view SHALL lay tasks out by target system and business phase

The Swimlane view SHALL place task nodes on a matrix whose columns are target systems and whose rows are L1 business phases, connected by execution-order edges.

列 = Flow 内 targetSystem 去重值（按出现序）加「未标注」兜底列，列头常显；行 = L1 业务阶段（左侧阶段带显示编号与名称）；条件分支的兄弟 L1 组合并为一条阶段带并标注分支标题；节点 = 下一级任务卡（嵌套数据为 L2 组卡、扁平数据为步骤卡），按其有效 targetSystem 落入对应列；箭头按执行顺序连接任务卡，Start/End 端点常显；Expand/Collapse 开关展开卡内明细。缺标签节点归入「未标注」列，不报错不隐藏。

#### Scenario: 泳道落位
- **WHEN** 某流程的 L2 组分别标注了不同 targetSystem 且切换到 Swimlane 视图
- **THEN** 任务卡落入对应系统列与所属阶段行的交叉区域，按执行顺序连线

#### Scenario: 并行分支阶段带
- **WHEN** 三个 L1 组是同一条件判断的分支兄弟
- **THEN** 三者合并为一条阶段带（如「03–05」）并显示分支标题，带内任务卡按执行顺序排列

#### Scenario: 未标注归置
- **WHEN** 某任务卡的有效 targetSystem 为空
- **THEN** 该卡落入「未标注」列，不因缺标签报错或被隐藏
