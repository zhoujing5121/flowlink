# Design

## Context

formalize-reference（已归档）为 Reference 落地了结构化校验：`VariableSchema.validation`（大小写/格式/正负/条件/公式）、`engine/reference` 的 expression/presets/describe/validate、主进程回放闸门与即时校验 IPC、渲染层预设优先编辑器与高级折叠区。真机反馈与产品方向调整（见 proposal.md - Why）：规则交由 AI 理解与执行、程序退出解析；展示层需要 Locator 来源列、Mandatory 改名、Value 后移、占位导出文件移除。

grill 定案：删结构化校验只留 Mandatory 拦截（存量规则经 describe 转中文句子迁移）；refine 顺带输出 variableRules 建议（AI 执行留后续 change）；Locator=来源定位描述（自动派生可编辑）。

## Goals / Non-Goals

**Goals:**

- 规则面收敛为一个自由文本字段，程序零解析；Mandatory/空串/附件注入语义保持。
- 存量 v3 数据无损转 v4（规则文本化、locator 回填），模板键与回放行为不变。
- 删除随之无用的引擎与 UI（表达式/预设/即时校验），不留死代码。

**Non-Goals:**

- 回放期 AI 理解/执行规则（后续独立 change，本 change 不把 rules 注入任何回放/接管提示词）。
- 程序侧对 rules 的解析、模板化或结构化还原。
- `required` 字段改名（仅显示层 Mandatory）。

## Decisions

### D1：schema v4——`validation` → `rules` + 新增 `locator`

`VariableSchema` 自 v4 起：删 `validation`（读取时剥离），增 `rules?: string`（自由文本，程序不解析）与 `locator?: string`（来源定位描述）；`required` 字段名不变、UI 显示 Mandatory。`SCHEMA_VERSION=4`。迁移 v3→v4：`validation` 各规则经 describe 语义转换为一段中文句子（多条以「；」连接，如「自动转大写；必须是邮箱格式；值自动计算：今天+7 天」）写入 `rules`；`locator` 用与 label 同源的步骤证据按「页面 · 控件」回填（页面取 systemName/页面标题/URL 路径，控件取 label/placeholder/角色）。备选「保留 validation 字段仅 UI 隐藏」被否：留双轨必然复活，删除才是方向落地。

### D2：引擎收缩与迁移转换器

`engine/reference`：删除 `expression.ts` 与 `presets.ts`（及其测试）；`describe.ts` 收缩为纯迁移转换器（仅 schema 迁移调用，不再服务 UI/闸门文案——闸门文案只剩必填缺失清单，模板字符串即可）；`validate.ts` 收缩为：必填缺失收集 + 非必填空串填充 + 附件绝对路径解析，删除格式/大小写/正负/条件/公式全部逻辑。主进程 `validateObject` IPC 收缩为 label 去重与必填检查（即时表达式校验入口删除）。`engine/executor` 值表解析同步收缩（不再有公式求值与大小写转换）。

### D3：AI variableRules——完全复用 variableLabels 管线

输出键 `variableRules: [{name, rules}]`；后置守卫与合并与 variableLabels 同一模式：未知机器键整次拒绝（同一报错面）、非空文本覆盖、确认界面可改；Mandatory 与 locator 不来自模型。`config/prompts.json` 在 systemPrompt 与 autoSanitize/refine 模板的参数条款追加规则建议指引（自然语言、语言随源、证据不足留空）。

### D4：渲染层——列序、单规则框、活动交互与观感

表格列序：勾选 | Object | Type | Locator | Mandatory | Validation | Activities | Value | 操作；Validation 列（列名保持现状）展示 `rules` 文本（CSS 单行截断 `text-overflow: ellipsis` + `title` 悬停全文）。观感：表格容器保持横向滚动，colgroup 各列宽度整体加大（Object/Locator/规则 为弹性宽列，Type/Mandatory/操作 固定窄列）。编辑对话框分区改为「基本（label/类型/Locator/值/Mandatory）/ 规则（单个多行文本框，自然语言占位）/ 活动关联」；预设控件、高级 `<details>`、表达式错误框与相关接线全部删除。活动列：每个已选活动渲染为独立行徽片（行间 margin 间隔）；点击徽片由渲染层切换到 Process 页签并触发对应 L1 分组的既有「点击选中」视觉（不新造高亮机制，复用分组选中描边；跨页签传递目标分组 id）；未 Refine 录制的整段隐含活动渲染为纯文本不可点击。占位文件：`ensureReferenceFiles` 移除 .xls/.md 生成分支（会话级产物，无存量清理），Download 打包保留仅含附件。Mandatory 为列头与开关文案，无逻辑变化。

### D5：Locator 派生与证据边界

录制端在 `applyRecordingLabels` 同点产出 locator（同一证据缓存，零额外扫描）；url 变量取「地址栏 · 目标系统名」，输入/下拉取「页面 · 控件」，上传占位取「页面 · 文件选择」。迁移回填同源。Locator 全程可编辑、AI 不改写（variableRules 只管规则文本）。证据缺失时 locator 为空串，不编造。

## Risks / Trade-offs

- [删除结构化校验后，格式错误只能在目标系统暴露（AI 执行未落地前无程序兜底）] → 既定方向变更；Mandatory 拦截保留最关键的缺失防线；规则文本随材料留存，AI 执行落地即可恢复语义。
- [describe 转换的句子质量影响迁移后可读性] → 转换器有单测锁定措辞；句子仅作起点，用户与 AI 建议可持续改写。
- [v3→v4 迁移面广（validation 消失）] → 迁移单测覆盖各规则组合；模板键/值/label 逐字节不变的既有断言沿用。
- [variableRules 增加生成失败面（未知键拒绝）] → 与 variableLabels 同面共担，拒绝信息点名键便于重试。

## Migration Plan

1. 惰性迁移 v3→v4（既有 migrateFlow 路径），无批量预迁移；回滚靠 `.bak`/回退提交，v4 字段对旧代码被 Zod 剥离。
2. 占位文件行为随代码移除即时消失，无数据迁移。
3. 旧构建打开 v4 Flow：schemaVersion 高于其 SCHEMA_VERSION 被拒（既有多版本策略）。

## Open Questions

（无——四个分叉均经 grill 定案，其余为实现细节。）
