# Spec Delta

## MODIFIED Requirements

### Requirement: The AI pane SHALL be advice-first with a single quick-actions strip

The AI pane SHALL be advice-first: all clickable AI actions live in one quick-actions strip above the chat composer, and the panel body stays informational.

快捷动作条是 AI 动作的唯一聚集地；无可行动作时自行隐藏。状态机：进入 Process 等分析标签页**不**自动显示欢迎选项；用户点击 Refine 按钮后出现三个欢迎选项（merge 合并所选 / generate 按描述生成 / optimize 优化当前流程）；选择 optimize 后才出现带预设勾选、自由文本与继续按钮的 refine 表单（merge/generate 选中后走各自现有流程）。Test 失败后不自动向 AI 发送消息、也不显示独立接管按钮；改为快捷区预设项：「Analyze last failure」（点击才把失败上下文发给 AI 面板生成分析）与「AI Continue」（点击触发单步接管循环：AI 只执行失败的那一步后回到程序回放，两败即停，无全量接管入口），风格与欢迎选项一致。分组重录/加节点动作、`@` 提及附件（自动补全、可移除徽片；Flow JSON 永不进入聊天记录）行为不变。针对已有 REFINED 录制的 AI 更新生成流程提案（非直接落盘），在 Process 标签页以并排前后流程图对比呈现，由用户 Apply/Discard。

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

## ADDED Requirements

### Requirement: The Record tab SHALL show per-step full-page screenshots

Record 标签页 SHALL 按步骤展示整页截图墙：新录制在停止后每个动作步骤对应一张整页图，按步骤序号命名与排序；无截图的旧录制保持空态展示（不渲染占位块）。

#### Scenario: 新录制的截图墙
- **WHEN** 用户停止一次包含 5 个动作步骤的录制并打开 Record 标签页
- **THEN** 截图墙按步骤顺序显示 5 张整页截图，点击可放大

#### Scenario: 旧录制空态
- **WHEN** 打开一段没有步骤截图的历史录制
- **THEN** 截图墙区域显示空态说明，不显示占位占块

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
