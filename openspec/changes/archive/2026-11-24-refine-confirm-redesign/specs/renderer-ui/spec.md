# Spec Delta

## MODIFIED Requirements

### Requirement: The AI pane SHALL be advice-first with a single quick-actions strip

The AI pane SHALL be advice-first: all clickable AI actions live in one quick-actions strip above the chat composer, and the panel body stays informational.

快捷动作条容纳欢迎选项（合并/生成/优化）、带预设勾选与自由文本及继续按钮的 refine 表单、唯一的 `AI Continue` 接管按钮（仅单步接管：AI 执行失败的那一步后回到程序回放；同名步骤两败即停，无全量接管入口）、分组重录/加节点动作；无可行动作时动作条自行隐藏。针对单个 REFINED 记录的 AI 更新以 pending 版本呈现（不直接落正式盘，见 `refine-lifecycle`）：AI 面板出现 Confirm / Discard 快捷方式，生成消息附结构化变更清单，不存在并排对比视图。聊天消息的生成意图由 advice 调用返回的意图标注判定（本地不再做关键字正则判定）；判定为 refine 时来源匹配优先级为 @ 引用 > 当前打开的录制 > 两者皆无时由 AI 列出候选名称请用户以 @ 回复指定；用户勾选录制并点击 Refine 按钮时必定触发生成，不经意图判定。`@` 提及把当前任务的已存录制作为附件（自动补全选择器、可移除徽片）；附件进入建议与细化，Flow JSON 永不进入聊天记录（载荷在主进程从 store 组装，UI 状态不持有）。

#### Scenario: 附件不入记录
- **WHEN** 用户 @ 附着一份 300 步的录制发送消息
- **THEN** 聊天记录只保存文本与附件徽片，UI 状态不持有 Flow 载荷

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
