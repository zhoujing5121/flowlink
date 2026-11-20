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

Pi SDK（`@earendil-works/pi-coding-agent`，不 spawn pi CLI）懒生成、空闲时 `unref`、超时终止、应用退出销毁；每次请求前校验设置与凭据形状；提示尺寸上限 100,000 字符；请求超时钳制 [5s, 600s]；渲染请求与 worker 响应按 id 关联。worker 内在导入 SDK 前安装 Undici `EnvHttpProxyAgent` 为全局 dispatcher；SDK 会话使用内存 session manager 与受限 `DefaultResourceLoader`（扩展、技能、提示模板、主题、上下文文件全部禁用），强制注入 FlowLink 系统提示——即 `config/prompts.json` 的 `systemPrompt`，当 `config/AGENTS.md` 存在且在预算内时，在其后以带标题的领域知识段追加该文件内容（作用于全部经 `runPiPrompt` 的调用，含 autoSanitize/refine/advice）；worker 资源加载限制不因该文件而放松。`noTools: "all"` 仅文本；模型运行时按 (auth path, provider, model) 缓存并在失败后重建。录制数据与页面文本按不可信证据对待，绝不作为指令。

#### Scenario: 超时终止
- **WHEN** 一次 Pi 请求超过钳制后的超时
- **THEN** worker 被终止并返回错误，请求不悬挂

#### Scenario: 提示注入防护
- **WHEN** 页面文本中包含指令样内容
- **THEN** 只作为证据参与提示，模型无工具、无执行能力

#### Scenario: AGENTS.md 追加系统提示
- **WHEN** `config/AGENTS.md` 存在且在预算内
- **THEN** Pi 会话系统提示为 prompts.json systemPrompt 加该文件的领域知识追加段，worker 加载器限制不变

## ADDED Requirements

### Requirement: Domain knowledge files SHALL load deterministically within hard budgets

可选领域知识文件 SHALL 由主进程确定性加载并在硬预算内注入提示；文件缺失时行为与现状完全一致。`config/AGENTS.md` 追加到 Pi 会话系统提示末尾（预算 8,000 字符）；`config/skills/` 下每个含 `SKILL.md` 的目录按 frontmatter 的 `name` + `description` + 正文拼接（合计预算 10,000 字符）注入两个生成模板的 `{{domainKnowledge}}` 占位符段，无 skill 时该段为明确的空值标记。超出任一预算或 frontmatter 非法时，相关 Pi 请求 SHALL 显式失败并指明违规文件，绝不静默截断。知识文件与 prompts.json 同信任级，不得解除元素与变量纪律。

#### Scenario: 缺失即无操作
- **WHEN** `config/AGENTS.md` 与 `config/skills/` 均不存在
- **THEN** 生成与建议的提示组装和报错行为与现状完全一致

#### Scenario: Skills 注入生成提示
- **WHEN** `config/skills/<name>/SKILL.md` 存在且 frontmatter 合法
- **THEN** 其 name、description 与正文进入 autoSanitize 与 refine 提示的领域知识段

#### Scenario: 预算超限响亮失败
- **WHEN** 知识文本超出对应预算上限
- **THEN** 相关 Pi 请求显式失败并指明违规文件，不截断继续

#### Scenario: 非法 frontmatter 失败
- **WHEN** 某 `SKILL.md` 缺少 `name` 或 `description`
- **THEN** 生成请求显式失败并指明该文件路径
