# Spec Delta

## MODIFIED Requirements

### Requirement: The Process tab SHALL render the flow as a semantic graph

The Process tab SHALL lay the flow out as a directed graph whose nodes and edges follow execution semantics, with no serial-list fallback, and SHALL render nested group levels as hierarchical nodes.

画布由 vendored 图引擎依赖承载（经 `dist/renderer-vendor.js` 全局变量进入，先于 app.js 加载；缺失时显示明确错误而非空白画布）。节点层级：L1 业务级分组、L2 技术级分组（现有 group）、L3 步骤详情；嵌套分组以层级节点呈现（内层组卡位于其外层组内）；未分组步骤仍以伪组呈现。既有交互保留：分支徽章、条件样式、点击选中、步骤右键、分组菜单（`getBoundingClientRect` 定位）；实线顺序边、标注是/否的条件边、虚线回跳边；组尾条件步骤抽出为菱形判定节点；卡片尺寸布局前实测、世界尺寸驱动 pan/zoom `fit()`。

#### Scenario: vendor 缺失
- **WHEN** dist/renderer-vendor.js 加载失败
- **THEN** Process 面板显示明确错误信息而非空白画布

#### Scenario: 嵌套分组渲染
- **WHEN** 打开一个含 L1/L2 两层嵌套分组的 Flow
- **THEN** 画布按层级呈现分组节点（L2 节点位于其 L1 内），边仍按执行语义连接

### Requirement: The Instruction tab SHALL present a two-layer editable view

The Instruction tab SHALL render every step as one editable plain-language sentence inside nested group cards, with an expandable technical drawer of kind-specific fields.

句子层内联编辑写 `label`，清空恢复自动措辞；分组卡片按层级嵌套呈现（内层组卡位于外层组卡内，层级可折叠），卡片头带业务阶段名、页签/URL 与分支进入徽章、Manual/Automation 来源、optional、manual-execution 步骤徽章，以及 `targetSystem` 标签的展示与编辑入口（自由文本，随 flow:updateSteps 校验落盘）。技术抽屉按类型组织结构化字段：URL、值、带修饰键的按键、等待条件与时长、断言及条件分支目标、抽取/上传/对话框/页签/滚动选项，及共享的 timeout、执行模式、isOptional、settle、expect 块。

#### Scenario: 清空恢复默认措辞
- **WHEN** 用户清空某步的 label 并保存
- **THEN** 该步恢复按操作类型合成的自动措辞

#### Scenario: 嵌套组卡编辑标签
- **WHEN** 用户在某 L1 组卡头编辑 targetSystem 标签并保存
- **THEN** 标签经 flow:updateSteps 校验落盘，重新加载后仍在

### Requirement: The per-step menu SHALL offer step operations with structural guards

The per-step ⋯ menu SHALL offer description editing, move up/down, delete, insert-after, and group re-record with structural guards, supporting nested group targets.

删除单步是快捷动作（无确认对话框、toast 确认步骤号；唯一组的最后一步不可删——Flow 必须保至少一步）；删除分组时：删空组连带清理指向它的条件分支引用，删除含子孙内容的分组前弹出确认并连同子孙一起删除、清理所有受影响分支引用；插入后继、移动与分组操作可指定嵌套层级内的目标分组。步骤行文本与录制后摘要来自单一 `processStepLabel` 来源（label 优先，缺省按操作类型合成中文措辞），Instruction/Process/Test 三处一致。

#### Scenario: 删除最后一步被拒
- **WHEN** 用户删除唯一分组的最后一步
- **THEN** 操作被拒绝并提示 Flow 必须保留至少一步

#### Scenario: 删除嵌套组清理分支
- **WHEN** 用户确认删除一个含 L2 子组的 L1 分组，且有条件分支指向其内步骤
- **THEN** 该组连同子孙删除，受影响的分支引用一并清理

## ADDED Requirements

### Requirement: Process numbering SHALL follow hierarchical tree position

Group and step codes SHALL be derived from their tree position as hierarchical numbers, displayed consistently across Process, Instruction, and Test.

编号规则：顶层分组按序 `01`、`02`…；其内分组续 `01-01`、`01-02`…；更深层级逐段延伸（`01-01-01`、`01-01-01-01`…）；步骤取其所在分组编号加段（无嵌套时 `01-01` 起，与现状一致）。编号在 Process 画布、Instruction 组卡与步骤行、Test 结果列表三处一致展示；编号是展示派生量，不落盘、不参与执行。

#### Scenario: 三处编号一致
- **WHEN** 打开一个 L1/L2 嵌套 Flow 的 Process、Instruction、Test 页签
- **THEN** 同一分组/步骤在三处显示相同层级编号

#### Scenario: 扁平数据编号不变
- **WHEN** 打开一个仅顶层分组的旧 Flow
- **THEN** 编号与现状一致（组 `01`…、步骤 `01-01`…）
