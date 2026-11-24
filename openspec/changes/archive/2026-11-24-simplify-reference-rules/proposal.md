# Proposal

## Why

formalize-reference 落地的结构化校验（预设控件 + 安全表达式引擎 + 回放期程序解析）对终端业务用户仍太技术化，且产品方向已明确：校验规则应由 AI 理解和执行，而不是程序解析。同时真机使用暴露三处表达问题：对象缺少「来自哪个页面哪个控件」的来源信息；列序与列名（Required→Mandatory、Value 后移）需要调整；录制/Refine 自动生成的 .xls/.md 两个占位导出文件没有实际价值。本 change 把 Reference 的规则面从「程序解析的结构化校验」转向「AI 理解的自由文本」，并完成展示层调整。

## What Changes

- **BREAKING（schema v4）**：删除结构化 `validation`（大小写/格式预设与正则/正负/条件表达式/公式表达式），替换为单个自由文本字段 `rules`（自然语言描述填写/校验规则）；新增 `locator` 字段（来源定位描述）。`required` 字段保留、显示名改 Mandatory。迁移 v3→v4：存量结构化规则经 describe 语义转换为中文句子写入 `rules`，locator 按录制证据回填。
- **程序侧校验收缩**：删除表达式引擎（expression/presets）与格式、大小写、公式、条件必填的全部程序侧行为；回放闸门只保留 Mandatory 缺失拦截（一次性报告全部缺失）与非必填空串注入、附件绝对路径注入。即时表达式校验 IPC 相应收缩。
- **规则交由 AI（本 change 到建议为止）**：refine 输出 `variableRules`（同 variableLabels 模式——依页面证据用自然语言建议每个变量的规则文本，未知机器键整次拒绝、非空覆盖、确认界面可改）；回放期 AI 理解与执行规则属后续独立 change，本 change 不实现。
- **Locator 列**：新增来源定位描述列（Type 后）——自动记录对象从哪个页面哪个控件拍取（如「订单列表 · 筛选面板『创建日期』输入框」），用户可编辑，录制端与迁移均自动产出。
- **表格列调整与观感**：列序为 勾选 | Object | Type | Locator | Mandatory | Validation | Activities | Value | 行操作；Validation 列（列名保持现状）保留在活动列之前，展示用户输入或 AI 生成的规则文本（单行截断、悬停提示全文）；表格区域支持横向滚动并加大各列宽度；Mandatory 为原 Required 的显示名变更。
- **活动列交互**：活动列不再只是文本——每个已选活动一行呈现（行间有间隔的徽片）；点击某个活动跳转到 Process 页并高亮该活动对应的 L1 分组；未 Refine 录制的整段隐含活动不可点击。
- **编辑对话框简化**：「填写规则」与「高级」两个分区整体替换为一个多行「规则」文本框（自然语言占位示例）；其余分区（基本/活动关联）与 720px 宽布局保留；预设控件、高级折叠、表达式即时校验全部移除。
- **占位文件移除**：录制与 Refine 生成 workflow 时不再自动产出 .xls/.md 步骤导出文件（会话级即时生成，移除生成代码即消失，无存量清理）；Download 打包保留，仅打包对象附件。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `reference`：校验模型从结构化规则改为自由文本 `rules`（程序不解析，AI refine 建议）；删除表达式语言与预设往返两条 requirement；新增 Locator 来源定位 requirement；类型显示映射措辞修正（地址→网址）。
- `flow-schema`：`validation` 字段删除、`rules`/`locator` 字段加入；SCHEMA_VERSION 3→4 与迁移（describe 语义转换、locator 回填）。
- `recording`：参数抽取在 label 之外同步产出 locator 来源定位描述。
- `replay-execution`：闸门收缩为 Mandatory 拦截 + 非必填空串 + 附件路径注入；移除格式/大小写/公式/条件检查。
- `ai-integration`：refine 输出契约与提示词新增 variableRules（自然语言规则建议）。
- `renderer-ui`：表格列序/Locator/Mandatory 改名/校验列移除/占位文件不再生成；编辑对话框以单规则文本框取代预设与高级区。

## Impact

- 引擎：`engine/schema`（v4 字段与迁移）、`engine/reference`（删除 expression.ts/presets.ts；validate.ts 收缩；describe.ts 保留为迁移转换器；labels/locator 派生）、`engine/recorder/src/record.ts`（locator 产出）、`engine/executor`（值表解析收缩）。
- 主进程：`src/main.ts`（闸门收缩、validateObject IPC 收缩）、`src/ai-refine.ts`（variableRules 合并与守卫）。
- 提示词：`config/prompts.json`（variableRules 输出指引）。
- 渲染层：`renderer/app.js`（列结构、对话框重构、删除预设/高级区/即时表达式校验、移除占位文件生成）、`renderer/index.html`、`renderer/app.css`。
- 测试：表达式/预设相关套件随引擎删除；新增 v4 迁移、variableRules、闸门收缩回归。
- 架构文档：`docs/architecture.md` Reference 一节同步。
- 兼容：`{{机器键}}` 模板、label、附件、活动关联语义不变；已实施的结构化校验行为（格式拦截、大小写转换、公式求值）随本 change 消失，属既定方向变更。

## Out-of-Scope

- 回放期 AI 理解与执行规则（含把 rules 注入接管/回放提示词）——后续独立 change。
- 程序侧对 rules 文本的任何解析、高亮或结构化还原。
- Mandatory 语义变更（仍为程序在回放启动前拦截缺失）与 `required` 字段改名（仅显示层改为 Mandatory）。
- 类型目录调整（显示名「网址」修正除外）与附件、活动关联、命名机制的改动。
- Download 打包格式调整（保留现状，仅内容随占位文件消失而只剩附件）。
