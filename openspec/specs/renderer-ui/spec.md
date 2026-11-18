# Renderer UI Specification

## Purpose

渲染层契约：模板化 UI 结构、Process 流程图、Instruction 双层编辑、Test 结果对齐、AI 面板、Record 回放与 Service Level 级联选择。渲染层是 UI 客户端——UI 状态、表单、设计/审阅视图与浏览器表面几何，不持有文件系统、Electron 对象或直接引擎调用。

## Requirements

### Requirement: UI structure SHALL be defined in index.html templates filled by JavaScript

UI structure SHALL be defined in `renderer/index.html` templates that JavaScript fills.

静态页面与面板结构（流程列表行、版本行、录制行、分析页签、AI 面板块）及重复项（如 `recordingLayoutTemplate`、分组改名/移动/合并对话框）在 `<template>` 元素中定义；仅当结构真正依赖运行时数据时才从 JS 生成 HTML——填模板，不在 JS 里手写静态标记。

#### Scenario: 重复行渲染
- **WHEN** 渲染录制列表
- **THEN** 行结构来自 index.html 模板，JS 只填数据

### Requirement: The Process tab SHALL render the flow as a semantic graph

The Process tab SHALL lay the flow out as a directed graph whose nodes and edges follow execution semantics, with no serial-list fallback.

分组卡片保持既有交互（分支徽章、条件样式、点击选中、步骤右键 修改/拆分、`getBoundingClientRect` 定位的分组菜单），按 dagre 坐标绝对定位，SVG 边层绘制真实连接：实线顺序边、标注 是/否 的条件边、虚线回边（目标在源之前，仍受三次进入上限约束）。组尾条件步骤抽出为独立菱形判定节点连接两个出向分组（一向下、一侧向，边沿 dagre 弯折点折线走）；只含条件的组消失进菱形，缺失分支终结于该段 End。卡片尺寸布局前从渲染 DOM 实测，世界元素显式宽高驱动 pan/zoom `fit()`。dagre 经 vendored 构建（`dist/renderer-vendor.js` → `window.__flowlinkDagre`，先于 app.js 加载）进入无打包器的渲染层。

#### Scenario: vendor 缺失
- **WHEN** dist/renderer-vendor.js 加载失败
- **THEN** Process 面板显示明确错误信息而非空白画布

### Requirement: The graph SHALL segment steps by sourceFlowId into parallel chains

Graph derivation SHALL segment steps by `step.sourceFlowId` and lay independent segments out as parallel chains.

无跨段条件边的段是独立连通分量——AI 合并的多源结果渲染为并行链、各自 Start/End 并按 `meta.sourceFlows` 着色带图例；存在跨段条件边则合并为一次布局。

#### Scenario: AI 合并流程分段
- **WHEN** 打开一个由两份录制合并生成的 Flow
- **THEN** 图形呈现两条并行链，各自 Start/End，按来源着色并有图例

### Requirement: Replay state SHALL overlay the graph live while blocking edits

Replay state SHALL overlay the Process graph live (aligned by step id) while blocking edits during the run.

步骤圆点与结果徽片、分组描边（绿=全过、红=有失败、灰=全跳过）、走过的边高亮、未走的分支边变暗；无论用户停在 Test 还是 Process 页签都实时刷新。多 `sourceFlowId` 的分组按 `meta.sourceFlows` 着色。

#### Scenario: 分支未走变暗
- **WHEN** 运行中某条件走了「是」分支
- **THEN** 该判定的「否」边变暗，两组件描边随结果实时更新

### Requirement: The Instruction tab SHALL present a two-layer editable view

The Instruction tab SHALL render every step as one editable plain-language sentence inside group cards, with an expandable technical drawer of kind-specific fields.

句子层内联编辑写 `label`，清空恢复自动措辞；分组卡片以业务阶段名命名，带页签/URL 与分支进入徽章、Manual/Automation 来源、optional、manual-execution 步骤徽章。技术抽屉按类型组织结构化字段：URL、值、带修饰键的按键、等待条件与时长、断言及条件分支目标、抽取/上传/对话框/页签/滚动选项，及共享的 timeout、执行模式、isOptional、settle、expect 块。

#### Scenario: 清空恢复默认措辞
- **WHEN** 用户清空某步的 label 并保存
- **THEN** 该步恢复按操作类型合成的自动措辞

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

The per-step ⋯ menu SHALL offer description editing, move up/down, delete, insert-after, and group re-record with structural guards.

删除是快捷动作（无确认对话框、toast 确认步骤号；删空组连带清理指向它的条件分支引用；唯一组的最后一步不可删——Flow 必须保至少一步）；插入后继复用 Process 手动步骤编辑器与元素库。步骤行文本与录制后摘要来自单一 `processStepLabel` 来源（label 优先，缺省按操作类型合成中文措辞），Instruction/Process/Test 三处一致。

#### Scenario: 删除最后一步被拒
- **WHEN** 用户删除唯一分组的最后一步
- **THEN** 操作被拒绝并提示 Flow 必须保留至少一步

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

快捷动作条容纳欢迎选项（合并/生成/优化）、带预设勾选与自由文本及继续按钮的 refine 表单、「用 AI 运行剩余步骤」接管按钮、分组重录/加节点动作；无可行动作时动作条自行隐藏。纯 label 润色作为 refine 预设之一（仅勾选它、无自由文本时走既有润色流：Pi 重写步骤标签、旧→新 diff 对话、确认后写回录制；与其他预设或自由文本组合则并入完整细化指令）。`@` 提及把当前任务的已存录制作为附件（自动补全选择器、可移除徽片）；附件进入建议与细化，Flow JSON 永不进入聊天记录（载荷在主进程从 store 组装，UI 状态不持有）。

#### Scenario: 附件不入记录
- **WHEN** 用户 @ 附着一份 300 步的录制发送消息
- **THEN** 聊天记录只保存文本与附件徽片，UI 状态不持有 Flow 载荷

### Requirement: Service Levels 1-4 SHALL be required cascading dropdowns backed by the process landscape

Service Levels 1–4 SHALL be required cascading dropdowns loaded from `process_landscape/full.json` through a dedicated preload API.

渲染层从不直接读该文件。

#### Scenario: 级联选项
- **WHEN** 用户选择 Service Level 1
- **THEN** 下级字段选项按层级刷新

### Requirement: The Record tab SHALL play back rrweb sessions with timeline and tab controls

The Record tab SHALL play back rrweb sessions with play/pause, a seekable timeline, and per-tab switching.

手动选择标签页时暂停自动跟随；Replayer 基础样式随 vendor 包（`dist/renderer-vendor.css`）提供，样式缺失时布局降级而不是把回放 iframe 挤出视野。

#### Scenario: 切换标签页视角
- **WHEN** 回放中用户手动选择另一标签页
- **THEN** 自动跟随暂停，视角切到所选标签页
