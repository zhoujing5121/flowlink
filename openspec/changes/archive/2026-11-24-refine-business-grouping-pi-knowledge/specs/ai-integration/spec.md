# Spec Delta

## MODIFIED Requirements

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce business-stage grouping, plain-language labels, and verification/branching invariants.

分组遵循「业务阶段分组方法」：先从源步骤识别业务对象与其状态推进，按**可验证的完成标志**切顶层分组——出现独立交付物、业务对象状态变化或系统/人机交接时才切新组，组名用动词+对象的业务行为命名（不按页面或技术命名）；强制 2–6 个带标签顶层业务分组与非技术用户可懂的步骤标签；每个顶层分组的完成标志以一行形式进入生成结果的 `rationale`。四层质量门显式化：入口可达（entry navigation）→ 已认证（gate condition）→ 目标内容可见（目标页 assert）→ 业务操作已生效（关键提交/确认/发送类操作后，仅当元素库存在结果证据时以 assert/expect 收尾验证，绝不发明结果元素）。条件分支最小化：仅当分支影响后续处理时才创建 `condition`，录制证据未显示真实路径分叉时不新增。登录门与导航后检查指向会话稳定的地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle；登录段保持门条件 + 容忍式登录组（可选凭据步骤收尾断言）以适配已登录/过期/记忆式 SSO——该结构与「打开+登录+进入列表并入首个业务阶段」的完成标志切法一致；录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板，未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 按完成标志切组
- **WHEN** 源录制呈现可辨识的业务对象状态推进（如形成交付物、状态变化、跨系统交接）
- **THEN** 生成的顶层分组以这些可验证业务结果为切分边界，组名为动词+对象的业务行为短语

#### Scenario: 业务生效验证
- **WHEN** 关键提交/确认类操作之后元素库中存在结果证据（确认页、状态元素）
- **THEN** 提示词要求以库内证据对该业务结果收尾验证；库内无证据时不新增任何结果元素

#### Scenario: 分支最小化
- **WHEN** 录制证据未显示影响后续处理的真实路径分叉
- **THEN** 除登录网关外不新增 `condition` 分支

#### Scenario: 完成标志进入 rationale
- **WHEN** 一次生成成功返回
- **THEN** 每个顶层分组在 `rationale` 中有一行对应的完成标志说明（与组标签同语言）

### Requirement: Pi sessions SHALL run in an on-demand worker thread with a restricted environment

Pi sessions SHALL run in an on-demand Node worker thread with a restricted environment.

Pi SDK（`@earendil-works/pi-coding-agent`，不 spawn pi CLI）懒生成、空闲时 `unref`、超时终止、应用退出销毁；每次请求前校验设置与凭据形状；提示尺寸上限 100,000 字符；请求超时钳制 [5s, 600s]；渲染请求与 worker 响应按 id 关联。worker 内在导入 SDK 前安装 Undici `EnvHttpProxyAgent` 为全局 dispatcher；SDK 会话使用内存 session manager 与受限 `DefaultResourceLoader`（扩展、提示模板、主题、上下文文件全部禁用），强制注入 FlowLink 系统提示——即 `config/prompts.json` 的 `systemPrompt`，当 `config/AGENTS.md` 存在且在预算内（≤8,000 字符）时，在其后以带标题的领域知识段追加该文件内容（作用于全部经 `runPiPrompt` 的调用，含 autoSanitize/refine/advice）；AGENTS.md 不能覆盖系统规则、输出契约或提升工具权限，worker 资源加载限制不因该文件放松。会话按请求分两种模式：

- **文本模式**（advice 等非生成调用与 prewarm）：保持 `noSkills: true`（无 override）且 `noTools: "all"`，模型无任何工具。
- **生成模式**（仅 `pi:generateFlow` 与 `pi:repairFlow`）：`noSkills: true` + skillsOverride 仅注入应用内置 Skills；`noTools: "builtin"` + `tools: ["read"]` + 唯一自定义受限 read 工具（命名锁定 `read`），最终模型可调用工具仅此一个。

模型运行时按 (auth path, provider, model) 缓存并在失败后重建。录制数据、页面文本与 Skill 内容均按不可信证据对待，绝不作为指令。

#### Scenario: 超时终止
- **WHEN** 一次 Pi 请求超过钳制后的超时
- **THEN** worker 被终止并返回错误，请求不悬挂

#### Scenario: 提示注入防护
- **WHEN** 页面文本或 Skill 内容中包含指令样内容
- **THEN** 只作为证据参与提示；工具边界由会话模式固定（文本模式无工具、生成模式仅受限 read），指令不能扩大边界

#### Scenario: AGENTS.md 追加系统提示
- **WHEN** `config/AGENTS.md` 存在且在预算内
- **THEN** Pi 会话系统提示为 prompts.json systemPrompt 加该文件的领域知识追加段，worker 加载器限制与工具权限不变

#### Scenario: 生成会话唯一工具
- **WHEN** `pi:generateFlow` / `pi:repairFlow` 的会话创建完成
- **THEN** 最终工具注册表仅含受限 read；Bash/PowerShell/Write/Edit/Grep/Find/LS 均不可用（以自动化断言验证）

#### Scenario: 非生成会话无 Skills
- **WHEN** advice 等其他 `runPiPrompt` 调用或 prewarm 运行
- **THEN** 不加载 Skills 且模型无工具，行为与现状一致

## ADDED Requirements

### Requirement: Built-in skills SHALL load via Pi's native skills mechanism within hard budgets

Skills SHALL be discovered only from the app-bundled `config/skills/` tree (default/user/project discovery off, injected via skillsOverride); skill bodies are never concatenated into generation prompts. Invalid frontmatter, duplicate names or over-budget content SHALL fail the Pi request loudly. Only `pi:generateFlow`/`pi:repairFlow` load skills; advice/takeover/prewarm do not.

#### Scenario: 缺失即无操作
- **WHEN** `config/skills/` 不存在或为空
- **THEN** 生成会话不含 Skills 提示段，提示组装与报错行为与现状一致

#### Scenario: 合法 Skill 仅在生成会话发现
- **WHEN** `config/skills/<name>/SKILL.md` 存在且 frontmatter 合法（`name` 为小写字母/数字/连字符且 ≤64 字符、`description` ≤1024 字符；描述合计 ≤8,000 字符、单个 SKILL.md ≤10,000 字符）
- **THEN** 其 name 与 description 经 Pi 原生 Skills 机制进入生成/修复会话的系统提示；advice/takeover/prewarm 会话不加载

#### Scenario: Skill 正文不整体注入
- **WHEN** 生成提示组装时存在合法 Skills
- **THEN** 提示只含原生 Skills 段（名称与描述），Skill 正文不内联拼接，模型经受限 read 按需读取

#### Scenario: 元数据或预算违规响亮失败
- **WHEN** 某 `SKILL.md` 缺少 `name`/`description`、命名非法、名称重复、含 `allowed-tools` 或 shell 命令插值，或描述合计/单个正文超出预算上限
- **THEN** 相关 Pi 请求显式失败并指明违规文件路径，不截断继续

### Requirement: The skill read tool SHALL be the only exposed tool and SHALL be restricted to built-in skill files

Generation sessions SHALL expose exactly one custom restricted read tool with its name locked to `read`: Pi injects the native skills prompt section only when a session declares a tool named `read` or `bash`, so renaming would hide skills from the model entirely. The tool SHALL read only built-in skill files within per-request budgets; no other tool is registered, and skill content cannot alter the tool whitelist.

#### Scenario: 越权路径拒绝
- **WHEN** 模型经 read 请求 Skill 目录外路径、路径穿越、符号链接逃逸、外部绝对路径、目录读取，或脚本/二进制/可执行文件
- **THEN** 读取被拒绝并返回明确错误，不返回任何文件内容

#### Scenario: 工具注册表唯一
- **WHEN** 生成模式会话创建完成
- **THEN** 自动化断言确认模型可调用工具仅为受限 read（可读范围限内置 Skill 根目录下 SKILL.md 及明确列入 Skill 包的纯文本参考文件）；Bash/PowerShell/Write/Edit/Grep/Find/LS 均不可用；断言失败（如内置 read 残留）属阻塞缺陷，重议设计而非改名绕过

#### Scenario: 读取预算超限
- **WHEN** 单次读取或每请求累计读取（合计 ≤20,000 字符）超出限额
- **THEN** 该读取被拒绝并提示预算已尽，不静默截断内容

## REMOVED Requirements

### Requirement: Auto-refine SHALL create a REFINED twin without touching the source recording

移除原因：录制后自动细化已在提案制改造中停用（`src/main.ts` 已移除 autoRefine 触发、设置与事件），该 requirement 与代码长期背离。本 change 明确不恢复自动细化，归档时同步移除；用户驱动的提案式细化经 `pi:generateFlow` 进行，其行为由其余 requirement 覆盖。
