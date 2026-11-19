# Spec Delta

## MODIFIED Requirements

### Requirement: The AI pane SHALL be advice-first with a single quick-actions strip

The AI pane SHALL be advice-first: all clickable AI actions live in one quick-actions strip above the chat composer, and the panel body stays informational.

快捷动作条是 AI 动作的唯一聚集地；无可行动作时自行隐藏。状态机：进入 Process 等分析标签页**不**自动显示欢迎选项；用户点击 Refine 按钮后出现三个欢迎选项（merge 合并所选 / generate 按描述生成 / optimize 优化当前流程）；选择 optimize 后才出现带预设勾选、自由文本与继续按钮的 refine 表单（merge/generate 选中后走各自现有流程）。Test 失败后不自动向 AI 发送消息、也不显示独立接管按钮；改为快捷区预设项：「Analyze last failure」（点击才把失败上下文发给 AI 面板生成分析）与「AI Continue」（点击触发单步接管循环：AI 只执行失败的那一步后回到程序回放，两败即停，无全量接管入口），风格与欢迎选项一致。**录制结束后不发生任何自动 AI 交互**：不自动调用 AI 分析、不自动产生 AI 消息、AI 面板也不自动打开；所有 AI 入口均由用户显式操作触发。分组重录/加节点动作、`@` 提及附件（自动补全、可移除徽片；Flow JSON 永不进入聊天记录）行为不变。针对已有 REFINED 录制的 AI 更新生成流程提案（非直接落盘），在 Process 标签页以并排前后流程图对比呈现，由用户 Apply/Discard。

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

## ADDED Requirements

### Requirement: The Record tab SHALL provide a replay diagnostics report

Record 标签页 SHALL 提供「回放诊断」按钮：点击后对当前录制的回放环境执行检查并展示**可复制**的诊断报告，至少包含——播放器 vendor 样式规则命中情况（如 `.replayer-mouse-tail` 的 computed position）、回放 iframe 的尺寸/位置与 computed 定位、事件总数与段数（Meta 快照数）、Replayer 元数据（时长/起始时间）、stage 与 tab-view 容器的布局值。报告以纯文本呈现，便于用户复制回传。

#### Scenario: 一键诊断
- **WHEN** 用户在 Record 标签页点击「回放诊断」
- **THEN** 页面展示一份包含上述检查项的文本报告，可一键复制

#### Scenario: 播放器未挂载时也可诊断
- **WHEN** 回放器尚未挂载或挂载失败时点击诊断
- **THEN** 报告如实给出对应状态（如事件数、加载错误），不抛异常

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
