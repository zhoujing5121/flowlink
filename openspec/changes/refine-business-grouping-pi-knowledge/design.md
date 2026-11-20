# Design

## Context

- config/prompts.json 是 Pi 提示词模板来源；src/pi-agent.ts 的 sendPiWorkerRequest 是 systemPrompt 中心组装点，覆盖现有 runPiPrompt 请求。
- Pi SDK 在 src/pi-agent-worker.ts 的 worker 中运行，版本锁定为 @earendil-works/pi-coding-agent@1.5.1。
- 当前会话禁用工具和 Pi 资源发现。原生 Skills 的按需读取需要受控 read 工具，不能只打开 Skills 而不给模型读取能力。
- 当前真实入口是 pi:generateFlow 与 pi:repairFlow。autoSanitize 是生成模板名，不代表录制完成后自动触发流程。
- advice 和 browser takeover 有独立调用语义；本 change 不给它们启用 Skills。
- 预算策略为超限显式失败，不静默截断。

## Goals / Non-Goals

**Goals**
- 将业务对象追踪、完成标志切组、四层质量门和最小条件分支规则加入 systemPrompt 与两个生成模板。
- 采用 Pi 原生 Skills，模型按需读取 Skill 文件，不把全部 Skill 正文拼进生成提示词。
- 以严格模式 A 限制 Pi：只读内置 Skills 文件，不读其他文件，不执行脚本。
- AGENTS.md 继续在中心 systemPrompt 组装点追加；Prompts、AGENTS.md、Skills 通过统一配置来源边界提供。
- 当前配置来源保持为应用内置 config/ 文件，为未来管理员配置页面保留接缝，但不实现未来管理功能。

**Non-Goals**
- 不实现管理员页面、用户账号、角色/RBAC、权限管理或用户级配置。
- 不启用任意文件工具、shell、脚本执行、Pi extensions 或插件。
- 不给 advice、takeover、prewarm 启用 Skills；不恢复录制后自动细化触发。
- 不改 Flow schema、IPC 对外契约或渲染层。

## Decisions

### D1. 小型 Pi 配置来源边界

将 Prompts、AGENTS.md、Skill 元数据与内置 Skill 路径的读取/校验集中在轻量模块或接口后面（例如 PiConfigSource，具体命名服从现有代码风格）。

- 当前唯一实现为 Built-in config source：读取应用内置 config/prompts.json、可选 config/AGENTS.md 和 config/skills/**/SKILL.md。
- 不引入数据库、用户级配置目录、网络 API、管理员身份或权限模型。
- 调用方依赖稳定的配置结果，而不是散落地直接读取文件；未来管理员页面可接入同一边界，不应要求重写 Pi worker 的安全边界。
- 这是内部接缝，不创建通用配置平台或过度抽象。

### D2. AGENTS.md 在中心 systemPrompt 组装点追加

在 src/pi-agent.ts 的 sendPiWorkerRequest 组装 systemPrompt 时，追加非空的 config/AGENTS.md，并用固定标题和限定语说明它不能覆盖系统规则、输出契约或安全边界。

- 对现有 runPiPrompt 路径一致生效。
- 建议上限 8,000 字符；超限显式报错，不静默截断。
- 缺少文件时为空操作，保持默认行为。
- AGENTS 内容不能提升 Pi 工具权限。

### D3. Pi 原生 Skills 通过受控 override 提供

- 只从内置 config/skills/ 发现带合法 SKILL.md 的 Skill 目录。
- frontmatter 至少校验 name 与 description；遵循 Pi 格式约束（name 小写字母/数字/连字符，最长 64；description 最长 1024）。拒绝重复名称、非法路径、缺失字段和无效元数据。
- 关闭默认/用户/项目 Skills 自动发现，并通过 Pi SDK DefaultResourceLoader 的 skillsOverride（或锁定版本中等效的受控入口）只提供 FlowLink 内置 Skills。
- 保持 noSkills: true 与 override 的组合行为必须通过 1.5.1 实测确认；若该版本不支持，使用等效的显式 Skills 列表构造方式，不能打开默认目录发现。
- Skills 只在 pi:generateFlow、pi:repairFlow 两个真实入口可用；advice、takeover、prewarm 不加载 Skills。

### D4. 严格只读工具：唯一自定义 read

Pi 会话采用「禁用所有内置工具，再仅允许一个自定义读取工具」的原则。

- 在锁定 SDK 版本上验证 noTools: "builtin" + tools: ["read"] + customTools: [restrictedRead] 的确切行为。
- 只注册自定义 read；其解析与打开文件逻辑必须自行实施 allowlist，不能调用默认通用文件读取器。
- 允许范围仅限内置 Skill 根目录下的 SKILL.md 及被明确列入 Skill 包的纯文本参考文件。不得读取项目源码、任意 config 文件、用户文件、系统文件或网络资源。
- 拒绝绝对路径、路径穿越、根目录外路径、符号链接逃逸、目录读取、二进制、可执行文件及脚本扩展名。
- 不注册 Bash、PowerShell、Write、Edit、Grep、Find、LS 等工具；Skill frontmatter 的 allowed-tools 与 shell 命令插值一律拒绝。
- 对最终工具注册表做测试：模型实际可调用的工具只有受限 read。若 SDK 出现内置 read 冲突，改用明确命名的 Skill 专用读取工具并同步调整 Skill 指令，不得暴露内置 read。

### D5. 预算与错误处理

以下是 FlowLink 侧建议限制，不是 Pi SDK 硬限制：

- AGENTS.md 最多 8,000 字符。
- 所有 Skill 描述合计最多 8,000 字符。
- 单个 SKILL.md 最多 10,000 字符。
- 单次请求最多启用 3 个 Skills，按任务相关性选择。
- 单次请求通过 read 累计读取 Skill 正文/参考内容最多 20,000 字符。

超限、非法 frontmatter、Skill 名称冲突、越权路径访问都应显式报错或拒绝；不得静默截断、放宽权限或回退到通用文件读取。读取工具限制单次读取长度并累计预算。

### D6. Skill 内容是参考数据，不是更高优先级指令

系统安全规则、Flow 输出契约、$ref 元素纪律、变量模板规则和工具白名单始终优先。Skill 不得覆盖系统提示、修改工具权限、要求读取 Skill 目录外文件或执行代码。页面文本、录制内容和 Skill 文件均视为不可信输入，仅作为业务知识/参考资料。

### D7. 分组方法论落点

- systemPrompt 增加紧凑的 Business-stage grouping method：识别业务对象及状态变化，按交付物/状态变化/交接切分组，组名采用动词+对象，落实四层质量门，只在影响后续处理时创建分支。
- rationale 每个顶层组一行描述完成标志，使用与组标签相同的语言。
- generation.autoSanitize 侧重清洗录制后按完成标志分组；generation.refine 侧重遵循用户指令并尽量少改动地优化分组。
- 第四层业务生效验证只在元素库存在结果证据时生成，不得臆造元素或结果。
- 保留 SSO 网关重构、清理、变量保护、$ref 和 timeout/settle 规则。

### D8. 文档和默认行为

新增 docs/pi-knowledge.md，说明配置分工、内置 Skills 目录/frontmatter、受限 read 的允许/拒绝范围、预算、验证方式、当前内置配置来源与未来配置页面扩展边界，并明确管理员页面和用户/角色系统属于后续范围。

不预置 AGENTS.md 或示例 Skill 文件，避免改变默认行为。打包后配置文件的可编辑/覆盖机制不在本 change 范围。

## Risks / Trade-offs

- **SDK 版本差异或 read 冲突**：对 1.5.1 做集成测试，验证 skillsOverride、noSkills、noTools、tools、customTools 组合和最终工具注册表；失败时采用 Skill 专用读取工具，不放开默认工具。
- **路径校验漏洞**：使用规范化路径、真实路径检查和符号链接边界检查；测试路径穿越、绝对路径、符号链接和编码绕过。
- **Skill 提示注入**：Skill 只作为参考数据；输出契约和工具权限由 FlowLink 固定控制。
- **模型忽略 Skills**：模型按需读取，真机验证 Skill 被正确发现和读取。
- **提示词变长**：不再内联全部 Skill 正文，描述与按需读取预算控制上下文增长。
- **未来配置页范围膨胀**：当前只定义配置来源边界，不实现 UI、身份、角色、存储或权限逻辑。

## Migration Plan

无用户数据迁移。未配置 AGENTS.md/Skills 时保持现有默认行为。实施后执行 npm run build、npx tsc --noEmit、SDK 工具注册测试、路径安全测试和真实生成/修复流程验证。回滚时恢复 Pi worker 原有无工具会话和配置读取逻辑即可。
