# Proposal

## Why

Reference 目前是渲染层的临时拼装：变量行统一显示为 "Variable" 类型、靠 `url_1`/`input_1` 这类机器名面向用户、上传文件只活在浏览器会话里（重启即丢）、必填与数据校验完全缺失。终端用户（业务人员）无法理解这些对象是什么、无法声明哪些数据必须有值、也无法表达「创建日期-开始/结束」这类业务语义。本 change 把 Reference 正式化为一等对象：原始类型 + 显示映射、业务命名、必填/校验/公式、活动关联、文件持久化。

## What Changes

- **去除 Variable 中间层，直接记录原始类型**：Reference 对象的类型从「Variable 包 string 等」改为直接持有原始类型（`url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`），并提供终端用户显示映射（地址、文本、整数、小数、日期、密钥、Excel、Word 等）；「正数」不设独立类型，降为校验规则。
- **Object 列与业务命名**：Reference 页第一列由 Name 改为 Object；新增 `label` 业务显示名（'地址'、'创建日期-开始'），UI/导出只显示 label，机器名（`url_1` 等）保留为模板/回放内部键、不再出现在用户视野。录制端依页面证据（label 文本/placeholder/aria-label/输入类型/成对日期）启发式生成 label；**BREAKING**：AI refine 提示词由「禁止改名」调整为「输出变量 label」，模型按证据给出业务命名。
- **必填列**：每个对象可标记必填；回放启动前统一校验，必填缺失则阻止启动并明确报错；非必填且无值改为填空串继续（现状是任何缺失变量硬失败，语义变化）。
- **校验列**：文本大小写（原样/大写/小写）、格式（预设 email/URL/手机号等 + 自定义正则）、正负规则、条件必填（安全表达式子集）、公式计算（同一表达式语言，含 `TODAY()`/`DATEADD()` 等日期函数与跨对象引用，回放启动时求值）。回放前一次性报告全部违规；UI 编辑即时标红。
- **活动关联列**：对象可多选关联 L1-activity（Refine 后的顶层业务分组）；未 Refine 的原始录制默认关联整段（隐含活动 = 录制名）。Reference 元数据随 Flow 版本落盘，Refine 产出的新材料对应新分组，不跨版本迁移关联。
- **文件持久化与 Word**：上传文件拷贝进录制工件 `references/` 子目录，元数据随 Flow 落盘，重启不丢；accept 列表新增 `.docx`。
- **Schema v3 迁移**：`VariableSchema` 扩展新字段并改造类型枚举，`SCHEMA_VERSION` 2→3，旧类型映射迁移（`text`→`string`、`email`→`string`+email 格式预设、`number`→按默认值判 `integer`/`decimal`），旧 Flow 存量 label 由共享启发式回填。

### 修订（2026-11-23 真机反馈）

- **对话框布局**：编辑/新建对话框加宽（480px → 约 720px，限高滚动），按「基本 / 填写规则 / 活动关联 / 高级」分区，基础字段两列网格，消除挤压错乱。
- **业务用户友好化**：校验编辑默认只呈现业务预设——必填开关、大小写选择、格式选择（不限制/邮箱/网址/手机号）、正负选择（中文短语）、日期自动计算预设（今天 / 今天±N 天）、句子式条件必填（「当『某对象』已填写时，本项必须填写」）；自定义正则与原始条件/公式表达式移入默认折叠的高级区（保留即时校验）。表格校验列与回放违规文案改用共享中文业务短句摘要（如「必填 · 自动转大写 · 自动计算：今天+7 天」）。预设与既有 validation 结构双向兼容，无法映射回预设的结构显示为「自定义规则」。
- **Refine 活动默认关联**：新材料变量活动关联默认值 = 使用证据推导（变量模板出现在哪些 L1 分组的步骤即关联哪些，多处即多选）；AI refine 额外输出 variableActivities 建议表，仅填充无使用证据的变量（未知分组 id 剔除、证据优先）；落盘时清除自源继承的过期分组 id。此前「AI 只管命名」边界修订为「AI 管命名 + 活动关联建议（证据优先）」。
- **修订轮 2/3（后续真机反馈）**：url 显示名「地址」→「网址」；日期自动计算预设按选项显隐 N 输入框（标签独占一行，下拉框与 N 输入框、「天」同行）；Add 按钮直开对象编辑框（删除中间选择弹窗）；文件类类型（Excel/Word/CSV/Markdown/文件）的值栏改为上传控件（显示文件名、覆盖上传、右侧删除），附件持久化于 references/ 并随对象元数据落盘，回放注入工件绝对路径（`VariableSchema` 增可选 `file` 字段）。

## Capabilities

### New Capabilities

- `reference`：Reference 对象契约——类型目录与显示映射、业务命名（label）规则、必填/校验（大小写/格式/正负/条件必填/公式）语义、安全表达式子集语言、活动关联语义、文件类对象的工件持久化边界。

### Modified Capabilities

- `flow-schema`：`flow.variables` 条目扩展 `label`/`type` 新枚举/`required`/`validation`/`activities` 字段；新增 `flow.referenceFiles` 持久化上传文件；`SCHEMA_VERSION` 升 v3 与旧类型迁移；模板键（机器名）与 `TEMPLATE_RE` 不变。
- `recording`：录制端参数抽取（`url_N`/`input_N`/`select_N`/`file_N`/`password`）同步产出业务 label（证据优先级 + 语义兜底 + 成对日期 -开始/-结束）。
- `replay-execution`：回放启动前 Reference 统一校验闸门（一次性报告全部违规、有错不启动）；非必填缺失填空串；大小写转换与公式求值并入变量解析；公式对象值只读由求值产生。
- `ai-integration`：refine 输出契约新增变量 label（机器名不可改，仅 label）；`mergeVariables` 合并 label；提示词按新命名职责调整。
- `renderer-ui`：Reference 页表格改列（Object/类型映射/必填/校验/活动关联/值），编辑对话框扩展，即时校验标红，文件上传走持久化链路。

## Impact

- 引擎：`engine/schema/src/schema.ts`（VariableSchema/referenceFiles/v3 迁移）、`engine/recorder/src/record.ts`（label 启发式）、`engine/executor/src/`（启动前校验闸门、模板解析并入大小写/公式语义）。
- 主进程：`src/main.ts`（`flow:updateVariables` 扩展字段、references 文件拷贝/删除 IPC、校验求值入口）、`src/ai-refine.ts`（`mergeVariables` label 合并与输出契约）。
- 提示词：`config/prompts.json`（systemPrompt 与 generation 模板的参数保留条款调整为 label 输出契约）。
- 渲染层：`renderer/app.js`（Reference 页新列/编辑器/即时校验/文件持久化）、`renderer/index.html`（表格与对话框模板）、`renderer/app.css`。
- 新增共享模块：类型目录 + 显示映射 + label 启发式 + 表达式引擎（engine 侧单实现，渲染层经 preload IPC 复用，遵守 preload 边界）。
- 架构文档：`docs/architecture.md`（Reference 一节，见 :110、:120）与本 change 同步更新。
- 兼容：模板 `{{url_1}}` 键不变、回放链路键不变；schema v3 迁移保持旧录制回放行为不变（除「非必填缺失填空串」为既定语义变化）；IPC 通道为新增非破坏。

## Out-of-Scope

- 机器名/模板语法的 Unicode 放宽与「真改名」（已决策走 label 显示名路线）。
- AI 填写必填/校验/活动关联（AI 只管命名，其余留给用户）。
- 跨 Refine 版本的关联自动迁移（版本化决策：新材料新分组，不迁移）。
- 批量回放 CSV 列头 label 映射（batch 能力未在桌面壳暴露，后续另立 change）。
- Reference 文件的在线预览/编辑、版本间 diff 视图。
- 自动生成的步骤导出文件（.xls/.md）行为保持现状。
- 历史版本查看/回滚 UI（既有 out-of-scope 延续）。
