# AI Integration Specification

## Purpose

Pi 编码代理集成契约：worker 会话与受限环境（内置 Skills、AGENTS.md 领域知识注入）、prompts.json 模板、细化生成管线（投影/提示/重水化/校验）、生成意图判定与传输失败重试、失败后的 AI 接管（全量/单步续跑/自由降级）、接管证据与自动修复回跑、代理与自定义端点。

## Requirements

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

### Requirement: All Pi prompts SHALL be maintained as placeholder templates in config/prompts.json

All Pi prompts SHALL be maintained as `{{placeholder}}` templates in `config/prompts.json`, loaded and validated by the main process.

覆盖会话系统提示、auto/refine 生成、AI 面板建议与 browser-takeover；缺失或非法文件使 Pi 请求显式失败（而非静默降级提示词）；系统提示注入 worker 会话，建议模板经 `pi:promptTemplates` IPC 交给渲染层。

#### Scenario: 配置损坏
- **WHEN** prompts.json 缺失或校验失败
- **THEN** Pi 请求返回显式错误

### Requirement: Generation SHALL project element references into a deduplicated library within hard budgets

Generation SHALL project every element reference into a deduplicated `$ref` library and fail loudly when hard budgets are exceeded.

管线（`src/ai-refine.ts`，IPC `pi:generateFlow`）完全在主进程运行，渲染层只发送录制 id、可选指令与纯文本会话。投影阶段把源步骤中所有 `target`/`from`/`to`/`expect.target` 替换为 `{"$ref":"eN"}`（键为 `fingerprint.stableHash` + 首候选），提示中每个库元素只出现一次；预算上限——库 10k、步骤 60k、会话 12k、指令 4k 字符——超限响亮失败而非截断。提示用 auto-sanitize 或 refine-with-instruction 两套固定模板，worker 系统提示额外禁止内联元素数据与 `flow.variables` 输出。

#### Scenario: 预算超限
- **WHEN** 源材料超出任一预算上限
- **THEN** 生成失败并报错，不截断提示继续

### Requirement: Rehydration SHALL accept only library references and validate before any persistence

Rehydration SHALL accept only `$ref` library references, and the rehydrated Flow SHALL pass schema validation before it is returned as a proposal.

未知 id 与内联元素对象被拒并点名违规步骤；库条目深克隆回填使 observed 证据逐字节还原；缺失步骤 id 生成、冲突加 `-2`/`-3` 后缀。校验经 `parseFlow`（含契约校验），变量自所有源合并、首个非密钥默认值胜出；模型可额外输出变量 label 表——机器键必须已在合并结果中存在（未知机器键拒绝），非空 label 覆盖启发式与旧值；模型亦可输出 variableActivities 建议表（机器键必须存在，未知分组 id 剔除），变量活动关联默认值以步骤模板使用证据推导优先、建议仅填充无使用证据的变量，落盘时清除自源继承的过期分组 id；其余 Reference 元数据（必填/校验）不来自模型输出、按源 Flow 保留。校验后的 Flow 作为提案返回，此处从不落盘——持久化只经用户驱动的 `recording:persistMerged` 保存为全新录制（`isMerged: true`，永不覆盖既有录制，非法输出在持久化关口被拒）。

#### Scenario: 拒绝内联元素
- **WHEN** 模型输出携带内联元素对象
- **THEN** 重水化拒绝并点名违规步骤

#### Scenario: 证据逐字节还原
- **WHEN** 提案步骤重水化完成
- **THEN** 其 observed 证据与源录制逐字节一致

#### Scenario: label 合并
- **WHEN** 模型为机器键 `input_2` 输出 label「客户名称」
- **THEN** 合并后该变量 label 为「客户名称」，机器键与模板引用不变

#### Scenario: 未知机器键拒绝
- **WHEN** 模型 label 表中出现源 Flow 不存在的变量机器键
- **THEN** 生成被拒绝并点名该键，不产出半成品 Flow

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce nested multi-level business-stage grouping, plain-language labels, target-system tags, variable business labels, and verification/branching invariants.

录制后分组（generation.autoSanitize）与 Refine（generation.refine）输出嵌套多级分组：L1 业务级分组（按业务对象状态推进与可验证完成标志切分——出现独立交付物、业务对象状态变化或系统/人机交接时才切新组，2–6 个、动词+对象命名，每组完成标志以一行进入生成结果 `rationale`）内含 L2 技术级分组、L2 内为 L3 步骤；输出深度约束 ≤3 级、顶层必须业务级、简单流程可省 L2；L1/L2 分组按录制证据（URL/域名/系统名）提取 `targetSystem` 自由文本标签，证据不足时省略而不是编造。四层质量门：入口可达 → 已认证 → 目标内容可见 → 业务操作已生效（关键提交/确认/发送类操作后，仅当元素库存在结果证据时以 assert/expect 收尾验证，绝不发明结果元素）。登录段在任何生成指令下都无条件主动重构（不依赖指令是否提及登录）：入口导航 → 网关 condition（判定已位于目标页时 `trueStepId` 指向凭据段之后的首个业务步骤；分支缺省=顺序继续）→ isOptional 容忍式凭据/账号选择步骤 → 目标页断言收尾，全部并入首个业务阶段组，登录不单独成组。条件分支最小化：仅当分支影响后续处理时才创建 `condition`，录制证据未显示真实路径分叉时不新增。步骤标签非技术用户可懂；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle。录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板且机器键不可改名；模型 SHALL 依页面证据为每个模板变量输出业务 label（语言随源材料、动词短语优先、成对区间加 -开始/-结束 后缀），并输出 variableActivities 建议表（按业务阶段与参数的使用关系把每个模板变量关联到其所属 L1 分组的 id；仅作默认值，使用证据优先）；未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 嵌套分组输出
- **WHEN** 录制后分组处理一份跨两个业务阶段的录制
- **THEN** 产出 Flow 的顶层为两个 L1 业务级 group，各自包含 L2 技术级 group 与 L3 步骤

#### Scenario: 标签证据不足省略
- **WHEN** 录制证据无法支持某 L1 组的 targetSystem 判断
- **THEN** 该组不带 targetSystem 标签，生成不因此失败

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

#### Scenario: 默认指令也重构登录段
- **WHEN** 用户以不含任何登录措辞的默认指令对一份含 SSO 登录段的原始录制执行 Refine
- **THEN** 生成结果包含网关 condition 与容忍式凭据步骤（位于首个业务阶段组内），未登录会话可走完登录、已登录会话直达业务步骤

#### Scenario: 登录并入业务组
- **WHEN** 生成含登录段的流程
- **THEN** 结果中不存在独立的 Sign in 顶层组

#### Scenario: 变量业务命名
- **WHEN** 生成结果中存在证据充分的 `input_N` 变量
- **THEN** 每个模板变量都携带按证据给出的业务 label

### Requirement: Generation failures SHALL surface full error text to the AI pane

细化/修复生成失败时，主进程 SHALL 把完整错误信息（含失败阶段与原因细节）随结果返回，AI 面板 SHALL 直接展示完整错误文本（可折叠详情），不要求用户查看日志文件。

#### Scenario: 生成失败展示
- **WHEN** 用户触发的 Refine 因模型输出无效而失败
- **THEN** AI 面板显示完整错误信息（含解析/校验失败原因），原始流程未被改动

### Requirement: Advice responses SHALL carry a machine-readable intent verdict

AI 面板的建议调用（advice prompt）SHALL 要求模型在回复中携带机器可读的意图判定标注（至少区分 `refine` 与 `advice` 两类），渲染层据此分流：判定为 `refine` 时按来源匹配规则发起生成，判定为 `advice` 时按建议呈现。标注解析失败时 SHALL 回退为纯文本建议呈现，不得因契约解析失败阻断或报错。本地关键字正则不再作为生成意图的判定依据。

#### Scenario: 意图判定为 refine
- **WHEN** 用户在聊天中发送希望改进工作流的消息且模型标注 intent 为 refine
- **THEN** 客户端随后按来源匹配优先级发起生成流程

#### Scenario: 标注缺失或非法
- **WHEN** 模型回复中不含可解析的意图标注
- **THEN** 回复按普通建议呈现，用户不看到错误

### Requirement: Transport-class model request failures SHALL retry once with an actionable message

主进程对模型调用 SHALL 识别传输类失败（连接被对端关闭、socket 中断、请求在收到响应前失败等非模型内容错误），并自动重试一次；重试仍失败时，错误文案 SHALL 指向网络代理空闲超时的排查方向（可操作），不得与"模型输出无效"类错误混淆呈现。

#### Scenario: 首次请求被代理掐断
- **WHEN** 生成请求首次因连接被对端关闭而失败
- **THEN** 系统自动重发一次同一请求

#### Scenario: 重试仍失败
- **WHEN** 重试后仍为传输类失败
- **THEN** 用户看到的错误信息包含代理空闲超时的排查指引

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

### Requirement: AI takeover SHALL run only on explicit user action under guardrails

AI takeover SHALL attach a browser-use agent to the embedded Chromium only on explicit user action, bounded by guardrails.

`@browser_use/pi` 经 CDP 附着同一 Chromium（保留失败现场；代理不拥有浏览器；REPL worker 优先系统 Node ≥22.19、回退 Electron 二进制）。护栏：导航域白名单来自 Flow 的录制 URL；每步重试；总预算 15 分钟；与回放共享 Stop 控制；密钥只经 SDK 脱敏 `sensitiveData` 通道；匿名遥测禁用（`telemetry: false`、`DO_NOT_TRACK=1`）；源 Flow 永不修改；接管工件 `ai-takeover.json` 只记 notes、证据与用量，绝不记密钥值。SDK 的 JavaScript worker 不是沙箱——接管只在显式用户动作下运行。

#### Scenario: 域白名单
- **WHEN** 代理试图导航到 Flow 录制域之外的地址
- **THEN** 导航被护栏拒绝

### Requirement: Takeover SHALL select steps branch-aware and handle unsupported step kinds explicitly

Takeover SHALL select its step subsequence branch-aware before the agent starts and SHALL handle each step kind explicitly.

门条件用执行器自身断言逻辑本地评估以挑选步骤子序列（跳过的组在 Test 列表显示 Skipped，决策写进代理任务与接管摘要），`condition` 步骤不交给代理「使其为真」。`openTab`/`switchTab`/`closeTab` 经代理执行（仅 `upload`/`script` 以明确原因终止接管）；`manual` 步骤经回放同款面板等待用户确认；需要 Reference 页从未保存的密钥变量时拒绝启动并明确报错。

#### Scenario: 缺密钥拒绝启动
- **WHEN** 剩余步骤需要 Reference 页从未保存的密钥变量
- **THEN** 接管以明确错误拒绝开始

### Requirement: Takeover SHALL degrade to free-run when a step defeats the agent twice

Takeover SHALL degrade to free-run when the same step defeats the agent twice, completing the remaining steps as one goal task with per-step reporting.

剩余步骤成为单一目标任务由代理自主完成并逐步上报（Test 列表同样带 AI 徽章，摘要注明自由运行完成情况）。进度经 `playback:aiStep`（带 stepId）/`playback:aiDone` 上报。

#### Scenario: 两败降级
- **WHEN** 同一步骤连续两次未被代理完成
- **THEN** 接管降级为自由运行模式继续完成剩余目标

### Requirement: Single-step AI continue SHALL resume program replay after the failed step

Single-step AI continue SHALL let the AI perform only the failed step and then resume program replay from the next step in the preserved browser state.

已执行前缀保留原结果，执行器把被绕过段上报为 skipped；每次测试运行至多 6 次单步介入；同一步两次击败 AI 时一次性回退到全量接管；「AI: 运行全部剩余步骤」保留旧的全接管路径；末次运行摘要与自动修复在整个循环结束后触发一次（而非按段触发）。

#### Scenario: 单步续跑
- **WHEN** 用户在某失败步骤点击 AI Continue
- **THEN** 仅该步由 AI 完成，程序回放从下一步继续，前缀结果保留

### Requirement: Completed takeover steps SHALL capture structured element evidence for automatic repair

Completed takeover steps SHALL capture structured element evidence (never input values) feeding the automatic repair.

每步从活动页面采集可交互元素的 tag/role/name/testid 写入 `ai-takeover.json`；自动修复把证据注入细化指令，并为元素库中匹配到的元素前置 `source: "ai"` 重锚候选（置于录制候选链之前；observed 证据保持不可变，输出仍通过完整 schema 契约）。接管结束后流程在后台自动优化并经校验持久化契约保存——目标为原始录制（Record）时另存为新的 `REPAIRED-…` 录制（原 Flow 及其测试结果不动、无按钮，进度与修复摘要落 AI 面板）；目标为单个 Refined 记录时直接以 version+1 落盘并写入生效前历史快照（不产生孪生，见 refine-lifecycle）；细化往返保留 `execution`/`settle`/`sourceFlowId` 字段而非静默丢弃。

#### Scenario: 证据采集
- **WHEN** 代理完成一个步骤
- **THEN** 该步元素证据写入 ai-takeover.json，不含任何输入值

### Requirement: A repair SHALL automatically re-run the test on the repaired flow at most twice

A repair SHALL automatically re-run the test on the `REPAIRED-…` flow at most two rounds, leaving the original recording untouched.

Test 进度头显示「· 自动回跑 N/2」徽章并在 AI 面板提示。

#### Scenario: 修复孪生
- **WHEN** 接管结束且修复目标为原始录制
- **THEN** 后台生成 REPAIRED-… 新录制并自动回跑测试（≤2 轮），原录制与其结果不变

### Requirement: Provider requests SHALL honor proxy configuration and custom endpoints

Provider requests SHALL honor proxy configuration and custom OpenAI-compatible endpoints.

worker 内代理经 `EnvHttpProxyAgent` 遵守 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（浏览器流量单独配置）；`--pi-system-proxy` 解析 Windows 代理/PAC 用于模型端点，`--pi-proxy=<URL>` 显式指定 HTTP/HTTPS/SOCKS5 代理；支持经 `config/models.json` 的通用 `custom` provider。Pi 配置位于工件树之外：`config/pi-settings.json`（provider/model/thinking/timeout 默认）与凭据 `config/pi-auth.json`（开发期）/`<userData>/pi-auth.json`（打包后）；凭据文件是密钥，永不提交、记录或打包。

#### Scenario: 显式代理
- **WHEN** 以 `--pi-proxy=socks5://…` 启动应用
- **THEN** 模型端点请求经该代理发出
