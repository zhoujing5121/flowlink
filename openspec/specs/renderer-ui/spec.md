# Renderer UI Specification

## Purpose

渲染层契约：模板化 UI 结构、Process 流程图（X6 画布：嵌套层级、Flow/Swimlane 视图、级别切换）、Instruction 双层编辑、Reference 对象管理、Test 结果对齐、AI 面板（意图判定与 pending Confirm）、Record 回放（rrweb + 步骤截图墙 + 诊断）与 Service Level 级联选择。渲染层是 UI 客户端——UI 状态、表单、设计/审阅视图与浏览器表面几何，不持有文件系统、Electron 对象或直接引擎调用。

## Requirements

### Requirement: UI structure SHALL be defined in index.html templates filled by JavaScript

UI structure SHALL be defined in `renderer/index.html` templates that JavaScript fills.

静态页面与面板结构（流程列表行、版本行、录制行、分析页签、AI 面板块）及重复项（如 `recordingLayoutTemplate`、分组改名/移动/合并对话框）在 `<template>` 元素中定义；仅当结构真正依赖运行时数据时才从 JS 生成 HTML——填模板，不在 JS 里手写静态标记。

#### Scenario: 重复行渲染
- **WHEN** 渲染录制列表
- **THEN** 行结构来自 index.html 模板，JS 只填数据

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

### Requirement: The graph SHALL segment steps by sourceFlowId into parallel chains

Graph derivation SHALL segment steps by `step.sourceFlowId` and lay independent segments out as parallel chains.

无跨段条件边的段是独立连通分量——AI 合并的多源结果渲染为并行链、各自 Start/End 并按 `meta.sourceFlows` 着色带图例；存在跨段条件边则合并为一次布局。

#### Scenario: AI 合并流程分段
- **WHEN** 打开一个由两份录制合并生成的 Flow
- **THEN** 图形呈现两条并行链，各自 Start/End，按来源着色并有图例

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

### Requirement: Process numbering SHALL follow hierarchical tree position

Group and step codes SHALL be derived from their tree position as hierarchical numbers, displayed consistently across Process, Instruction, and Test.

编号规则：顶层分组按序 `01`、`02`…；其内分组续 `01-01`、`01-02`…；更深层级逐段延伸（`01-01-01`、`01-01-01-01`…）；步骤取其所在分组编号加段（无嵌套时 `01-01` 起，与现状一致）。编号在 Process 画布、Instruction 组卡与步骤行、Test 结果列表三处一致展示；编号是展示派生量，不落盘、不参与执行。

#### Scenario: 三处编号一致
- **WHEN** 打开一个 L1/L2 嵌套 Flow 的 Process、Instruction、Test 页签
- **THEN** 同一分组/步骤在三处显示相同层级编号

#### Scenario: 扁平数据编号不变
- **WHEN** 打开一个仅顶层分组的旧 Flow
- **THEN** 编号与现状一致（组 `01`…、步骤 `01-01`…）

### Requirement: The Process canvas SHALL provide group and step context menus with transform-aware positioning

Process 画布 SHALL 提供两类右键菜单：右键**组卡**任意处弹出组菜单（重命名、上移、下移、并入下一组、删除、重录该组、在其前/后插入——与现有组操作按钮同源能力）；右键**步骤行**弹出步骤菜单（编辑描述/展开技术字段/上移/下移/其后插入/删除/重录所在组，行为同现状）。菜单定位 SHALL 在画布平移（translate）与缩放（scale）下保持正确（按画布坐标系换算），且右键目标可命中（组卡空白、标题、步骤行分别得到对应菜单，不再出现右键无响应）。

#### Scenario: 组卡空白处右键
- **WHEN** 用户右键组卡的标题或空白区域
- **THEN** 弹出组菜单于光标处，各项操作与组操作按钮等效

#### Scenario: 缩放平移后定位正确
- **WHEN** 用户缩放到 60% 并平移画布后右键某步骤
- **THEN** 步骤菜单出现在光标所在位置（不因变换偏移到别处）

#### Scenario: 菜单外点击关闭
- **WHEN** 菜单打开后用户点击菜单外任意处或按 Esc
- **THEN** 菜单关闭，不触发其它画布行为

### Requirement: The Instruction tab SHALL present a two-layer editable view

The Instruction tab SHALL render every step as one editable plain-language sentence inside nested group cards, with an expandable technical drawer of kind-specific fields.

句子层内联编辑写 `label`，清空恢复自动措辞；分组卡片按层级嵌套呈现（内层组卡位于外层组卡内，层级可折叠），卡片头带业务阶段名、页签/URL 与分支进入徽章、Manual/Automation 来源、optional、manual-execution 步骤徽章，以及 `targetSystem` 标签的展示与编辑入口（自由文本，随 flow:updateSteps 校验落盘）。技术抽屉按类型组织结构化字段：URL、值、带修饰键的按键、等待条件与时长、断言及条件分支目标、抽取/上传/对话框/页签/滚动选项，及共享的 timeout、执行模式、isOptional、settle、expect 块。

#### Scenario: 清空恢复默认措辞
- **WHEN** 用户清空某步的 label 并保存
- **THEN** 该步恢复按操作类型合成的自动措辞

#### Scenario: 嵌套组卡编辑标签
- **WHEN** 用户在某 L1 组卡头编辑 targetSystem 标签并保存
- **THEN** 标签经 flow:updateSteps 校验落盘，重新加载后仍在

### Requirement: Instruction edits SHALL persist through the validated flow contract

Every Instruction edit SHALL persist through the validated `flow:updateSteps` contract, rolling back with an inline error on validation failure.

写盘伴随版本递增与 `.bak` 备份。技术抽屉的目标是只读证据查看器（crop 截图、候选列表 kind/score/source、指纹摘要、邻近文本），由路径校验的只读 `recording:artifactsPath` IPC 提供；改目标被有意限制为重录该组或引用 Flow 中已捕获元素；密码字段值保持掩码。未保存编辑在切换页签时冲盘落盘，测试从同一扁平步骤索引重建。

#### Scenario: 编辑真正落盘
- **WHEN** 用户在技术抽屉修改某字段并保存
- **THEN** 经 flow:updateSteps 校验写入 Flow 文件（版本+.bak），失败则行内报错回滚

#### Scenario: 密码掩码
- **WHEN** 查看密码输入步骤的证据
- **THEN** 值始终掩码显示

### Requirement: The per-step menu SHALL offer step operations with structural guards

The per-step ⋯ menu SHALL offer description editing, move up/down, delete, insert-after, and group re-record with structural guards, supporting nested group targets.

删除单步是快捷动作（无确认对话框、toast 确认步骤号；唯一组的最后一步不可删——Flow 必须保至少一步）；删除分组时：删空组连带清理指向它的条件分支引用，删除含子孙内容的分组前弹出确认并连同子孙一起删除、清理所有受影响分支引用；插入后继、移动与分组操作可指定嵌套层级内的目标分组。步骤行文本与录制后摘要来自单一 `processStepLabel` 来源（label 优先，缺省按操作类型合成中文措辞），Instruction/Process/Test 三处一致。

#### Scenario: 删除最后一步被拒
- **WHEN** 用户删除唯一分组的最后一步
- **THEN** 操作被拒绝并提示 Flow 必须保留至少一步

#### Scenario: 删除嵌套组清理分支
- **WHEN** 用户确认删除一个含 L2 子组的 L1 分组，且有条件分支指向其内步骤
- **THEN** 该组连同子孙删除，受影响的分支引用一并清理

### Requirement: Step flattening and event alignment SHALL have a single shared implementation

Step flattening and playback event alignment SHALL come from one shared implementation used by the Test list, the Process graph, and all playback event handlers.

`renderer/flow-graph.js` 的 `flattenFlowSteps` 是唯一扁平化实现（步骤 id 带分组前缀，与 `engine/executor/src/steps.ts` 一致）；`playback:step`/`done`/`aiStep` 事件按其对齐（`aiStep` 现带 `stepId`，`stepIndex` 为旧回退），显示顺序与结果对齐不会漂移。运行未达的步骤显示 Pending、引擎跳过的显示灰色 Skipped；AI 完成的步骤带 AI 徽章。

#### Scenario: 分支跳过不串行
- **WHEN** 条件跳转越过多步
- **THEN** 被跳过步骤显示灰色 Skipped，后续结果按 id 对齐到正确行

### Requirement: The AI-pane progress list and taskflow Run action SHALL go through the Test entry

The AI-pane progress list SHALL mirror the graph group-by-group, and the taskflow Run action SHALL go through the same entry as the Test panel.

进度列表按过程分组（编号、名称、组状态）与图形一一对应；分支跳过的组变暗并带「Skipped · 分支未走」徽片。Run 动作初始化步骤列表与运行标志、切换视图后再回放，不再后台无反馈运行。

#### Scenario: 列表运行有反馈
- **WHEN** 用户从任务流列表点击 Run
- **THEN** 视图切到 Test 并逐步显示回放进度

### Requirement: The AI pane SHALL be advice-first with a single quick-actions strip

The AI pane SHALL be advice-first: all clickable AI actions live in one quick-actions strip above the chat composer, and the panel body stays informational.

快捷动作条是 AI 动作的唯一聚集地；无可行动作时自行隐藏。状态机：进入 Process 等分析标签页**不**自动显示欢迎选项；用户点击 Refine 按钮后出现三个欢迎选项（merge 合并所选 / generate 按描述生成 / optimize 优化当前流程）；选择 optimize 后才出现带预设勾选、自由文本与继续按钮的 refine 表单（merge/generate 选中后走各自现有流程）。Test 失败后不自动向 AI 发送消息、也不显示独立接管按钮；改为快捷区预设项：「Analyze last failure」（点击才把失败上下文发给 AI 面板生成分析）与「AI Continue」（点击触发单步接管循环：AI 只执行失败的那一步后回到程序回放，两败即停，无全量接管入口），风格与欢迎选项一致。**录制结束后不发生任何自动 AI 交互**：不自动调用 AI 分析、不自动产生 AI 消息、AI 面板也不自动打开；所有 AI 入口均由用户显式操作触发。针对单个 REFINED 记录的 AI 更新以 pending 版本呈现（不直接落正式盘，见 `refine-lifecycle`）：AI 面板出现 Confirm / Discard 快捷方式，生成消息附结构化变更清单，不存在并排对比视图。聊天消息的生成意图由 advice 调用返回的意图标注判定（本地不再做关键字正则判定）；判定为 refine 时来源匹配优先级为 @ 引用 > 当前打开的录制 > 两者皆无时由 AI 列出候选名称请用户以 @ 回复指定；用户勾选录制并点击 Refine 按钮时必定触发生成，不经意图判定。分组重录/加节点动作、`@` 提及附件（自动补全、可移除徽片；Flow JSON 永不进入聊天记录，载荷在主进程从 store 组装，UI 状态不持有）行为不变。

#### Scenario: 附件不入记录
- **WHEN** 用户 @ 附着一份 300 步的录制发送消息
- **THEN** 聊天记录只保存文本与附件徽片，UI 状态不持有 Flow 载荷

#### Scenario: 快捷菜单按需出现
- **WHEN** 用户进入某工作流的 Process 标签页且未点击 Refine
- **THEN** AI 面板快捷区不显示 merge/generate/optimize 欢迎选项

#### Scenario: Refine 按钮展开欢迎选项
- **WHEN** 用户选中工作流并点击 Refine 按钮
- **THEN** 快捷区显示 merge/generate/optimize 三个欢迎选项；选择 optimize 后出现预设勾选与自由文本表单

#### Scenario: 失败分析需用户触发
- **WHEN** Test 运行失败且用户未做任何操作
- **THEN** AI 面板不自动出现失败分析消息，仅快捷区显示「Analyze last failure」与「AI Continue」预设项；点击前者才发送失败上下文

#### Scenario: 停录后无自动 AI 交互
- **WHEN** 一次录制正常结束并进入分析页
- **THEN** 不产生任何自动 AI 消息或分析请求，AI 面板不自动打开；用户手动打开面板后各预设项可用

#### Scenario: 聊天触发 refine 且带引用
- **WHEN** 意图判定为 refine 且消息 @ 引用了某个录制
- **THEN** 生成以被引用的录制为来源发起，忽略勾选与其它上下文

#### Scenario: 聊天触发 refine 无引用
- **WHEN** 意图判定为 refine 且消息无 @ 引用
- **THEN** 生成以当前打开的录制为来源发起

#### Scenario: 聊天触发 refine 且无引用无当前打开
- **WHEN** 意图判定为 refine 但既无 @ 引用也无当前打开的录制
- **THEN** AI 回复列出候选录制名称，请用户以 @ 引用回复后继续

#### Scenario: Refine 按钮直达生成
- **WHEN** 用户勾选一个或多个录制并点击 Refine 按钮完成表单提交
- **THEN** 生成必定发起，不做任何意图判定

### Requirement: Refine instructions SHALL render as removable chips plus a text section

refine 表单中的已勾选预设 SHALL 以可移除的标签徽章（chips）呈现在输入区上方，自由文本为独立文本段；在文本框输入 SHALL 不重置已勾选状态。提交时勾选项与文本组装为多行结构化指令文本发送。

#### Scenario: 输入不重置勾选
- **WHEN** 用户先勾选两个预设再在自由文本框输入补充说明
- **THEN** 两个预设保持勾选（chips 不消失），消息可同时携带两项预设与文本

#### Scenario: chips 可移除
- **WHEN** 用户点击某个已勾选预设的徽章移除按钮
- **THEN** 该预设取消勾选且徽章消失，其余勾选保持

#### Scenario: 消息呈现
- **WHEN** 用户提交带两个预设与一段补充文本的 refine 请求
- **THEN** 聊天记录以预设徽章 + 独立文本段的形式展示该消息

### Requirement: The Reference tab SHALL present typed objects with business-language columns

Reference 页 SHALL 以表格管理对象：勾选列 + Object（label 业务名）+ 类型（终端显示映射，不出现 "Variable" 包装）+ 值 + 必填 + 校验（中文业务短句摘要，如「必填 · 自动转大写 · 自动计算：今天+7 天」，不出现枚举值与表达式语法）+ 活动关联（多选 L1 分组，原始录制显示整段）+ 行操作。回放闸门拒绝时的违规文案同用业务短句；机器键不在任何用户可见处出现；文件上传支持 .xlsx/.xls/.csv/.md/.docx 并走工件持久化链路，保存经校验后的变量契约落盘并版本递增。

#### Scenario: 新列呈现
- **WHEN** 打开一份含变量与上传文件的录制的 Reference 页
- **THEN** 表格呈现 Object/类型映射/值/必填/校验/活动列，变量行与文件行同表，类型列显示终端映射名

#### Scenario: 机器键不可见
- **WHEN** 用户查看或编辑任一对象
- **THEN** 界面只出现 label 业务名，机器键不显示

### Requirement: The object editor dialog SHALL be wide and preset-first with an advanced fold

编辑/新建对话框 SHALL 宽度充足（约 720px、限高滚动、窄窗口不挤压）并按「基本 / 填写规则 / 活动关联 / 高级」分区。默认视图只呈现业务预设控件：label 去重、类型映射、必填开关、大小写/格式/正负选择、日期自动计算预设（今天 / 今天±N 天）、句子式条件必填（「当『某对象』已填写时本项必填」）；自定义正则与原始条件/公式表达式归入默认折叠的高级区，展开后保留即时语法校验与保存阻断；无法映射回预设的结构显示「自定义规则」。

#### Scenario: 预设优先编辑
- **WHEN** 业务用户打开编辑对话框且未展开高级区
- **THEN** 只看到中文业务预设控件，无正则与表达式语法；展开高级区才出现原始表达式编辑

#### Scenario: 编辑即时校验
- **WHEN** 用户在高级区输入一条语法非法的公式并触发校验
- **THEN** 对话框内即时报错并阻止保存，错误定位到表达式

### Requirement: The Add action SHALL open the editor directly and file-typed values SHALL use an upload control

Reference 页的 Add 按钮 SHALL 直接打开对象编辑对话框，不经过任何中间选择弹窗。编辑对话框中类型为 Excel/Word/CSV/Markdown/文件 的对象，值栏呈现为上传控件：无附件时点击即选择文件上传；有附件时控件显示文件名、点击可覆盖上传、右侧提供删除按钮；保存后表格值列显示该文件名。非文件类类型保持文本值输入，密钥保持掩码输入。

#### Scenario: Add 直开编辑框
- **WHEN** 用户点击 Reference 页的 Add 按钮
- **THEN** 直接出现对象编辑对话框，没有中间的选择弹窗

#### Scenario: 文件类值栏上传
- **WHEN** 用户把类型选为 CSV 并在值栏上传一个文件后保存
- **THEN** 表格值列显示该文件名，再次打开编辑器时值栏控件显示同一文件名且可覆盖或删除

### Requirement: Service Levels 1-4 SHALL be required cascading dropdowns backed by the process landscape

Service Levels 1–4 SHALL be required cascading dropdowns loaded from `process_landscape/full.json` through a dedicated preload API.

渲染层从不直接读该文件。

#### Scenario: 级联选项
- **WHEN** 用户选择 Service Level 1
- **THEN** 下级字段选项按层级刷新

### Requirement: The Record tab SHALL play back rrweb sessions with timeline and tab controls

The Record tab SHALL play back rrweb sessions with play/pause, a seekable timeline, and per-tab switching.

回放器在内嵌应用窗口内 SHALL 完整渲染录制画面：每个标签页的 Replayer 挂载后其回放 iframe SHALL 位于舞台可视区内且尺寸非零（量测等待 iframe 完成异步渲染，等待期内显示加载态）；Replayer 基础样式随 vendor 包（`dist/renderer-vendor.css`）加载，加载失败时以显式错误提示而非黑屏。手动选择标签页时暂停自动跟随。

#### Scenario: 切换标签页视角
- **WHEN** 回放中用户手动选择另一标签页
- **THEN** 自动跟随暂停，视角切到所选标签页

#### Scenario: 多段导航录制可见
- **WHEN** 回放一段跨多次导航的录制并拖动时间轴到后续时段
- **THEN** 舞台渲染该时段所属文档的画面（非黑屏/非首屏停留）

#### Scenario: 样式缺失显式报错
- **WHEN** 回放器基础样式未能加载
- **THEN** Record 页显示明确错误信息，而不是静默黑屏

### Requirement: The Record tab SHALL show per-step full-page screenshots

Record 标签页 SHALL 按步骤展示整页截图墙：新录制在停止后每个动作步骤对应一张整页图，按步骤序号命名与排序；无截图的旧录制保持空态展示（不渲染占位块）。

#### Scenario: 新录制的截图墙
- **WHEN** 用户停止一次包含 5 个动作步骤的录制并打开 Record 标签页
- **THEN** 截图墙按步骤顺序显示 5 张整页截图，点击可放大

#### Scenario: 旧录制空态
- **WHEN** 打开一段没有步骤截图的历史录制
- **THEN** 截图墙区域显示空态说明，不显示占位占块

### Requirement: The Record tab SHALL provide a replay diagnostics report

Record 标签页 SHALL 提供「回放诊断」按钮：点击后对当前录制的回放环境执行检查并展示**可复制**的诊断报告，至少包含——播放器 vendor 样式规则命中情况（如 `.replayer-mouse-tail` 的 computed position）、回放 iframe 的尺寸/位置与 computed 定位、事件总数与段数（Meta 快照数）、Replayer 元数据（时长/起始时间）、stage 与 tab-view 容器的布局值。报告以纯文本呈现，便于用户复制回传。

#### Scenario: 一键诊断
- **WHEN** 用户在 Record 标签页点击「回放诊断」
- **THEN** 页面展示一份包含上述检查项的文本报告，可一键复制

#### Scenario: 播放器未挂载时也可诊断
- **WHEN** 回放器尚未挂载或挂载失败时点击诊断
- **THEN** 报告如实给出对应状态（如事件数、加载错误），不抛异常
