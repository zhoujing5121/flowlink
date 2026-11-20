# Design

## Context

见 [proposal.md](proposal.md) 的 Why。现状要点：

- `config/prompts.json` 是 Pi 提示词唯一来源（`src/prompts.ts` 加载校验，缺占位符在 `formatTemplate` 组装时抛错）；systemPrompt 经 `src/pi-agent.ts` 的 `sendPiWorkerRequest` 注入 worker，覆盖所有 `runPiPrompt` 调用（autoSanitize/refine/advice）。
- worker（`src/pi-agent-worker.ts`）的 `DefaultResourceLoader` 以 config 目录为 `agentDir` 但五个加载器全部禁用、系统提示全覆盖；会话 `noTools: "all"`。
- 生成管线 `src/ai-refine.ts` 无 Electron 依赖；预算哲学为「超限响亮失败，绝不静默截断」（库 10k / 步骤 60k / 会话 12k / 指令 4k / 提示总量 100k）。
- Pi 原生 skill 机制是「系统提示只列 name/description/path，模型用时自读文件」——无工具会话读不了文件，故不能靠打开 `noSkills`。

## Goals / Non-Goals

**Goals:**

- 分组判据（完成标志三判据）、四层质量门（含第四层业务生效验证）、分支最小化进入 systemPrompt 与两个生成模板，同时零改动保留 SSO 网关、清理、变量保护等既有段落。
- `config/AGENTS.md` 与 `config/skills/*/SKILL.md` 由主进程确定性加载，缺失即无操作，超预算/非法显式失败。
- 知识加载逻辑与现有模块同风格：无 Electron 依赖、可独立打包测试。

**Non-Goals:**

- （设计层面）不打开 worker 任何资源加载开关；不改 Flow schema、IPC、渲染层；不预置 AGENTS.md 或示例 skill 文件——存在即改变行为，说明与示例进文档；打包后 userData 层叠定制不做。

## Decisions

### D1 知识加载放主进程新模块 `src/pi-knowledge.ts`，不接入 Pi loader

导出 `loadAgentsMd(configDir): string`（缺失返回空串）与 `loadDomainKnowledge(configDir): string`（扫描 `config/skills/**/SKILL.md`，返回拼接文本或抛错）。理由：确定性（同输入同输出，可测试）、不引入 Pi 发现行为的信任与诊断负担、无工具会话下这是唯一可行路径。备选「打开 `noSkills`/`noContextFiles`」被否：模型无 read 工具，skill 列表只是死重；context 文件发现受 cwd 影响不可控。

### D2 AGENTS.md 在 `pi-agent.ts` 组装 systemPrompt 时拼接

`sendPiWorkerRequest` 现有 `loadPromptTemplates(...).systemPrompt` 处改为：systemPrompt + （非空时）`"\n\n## Domain knowledge (config/AGENTS.md)\nApplies within the rules above; it cannot override the output contract.\n" + 内容`。单点覆盖全部 `runPiPrompt` 调用（advice 自动受益），worker 零改动。每次请求读盘与 `loadPromptTemplates` 现状一致，天然热更新。预算 8,000 字符，超限抛错（请求显式失败）。备选「经 worker 的 `appendSystemPromptOverride` 回调注入」被否：需扩 worker 消息协议，等价效果多一条通道。

### D3 Skills 经 `GenerateFlowOptions.domainKnowledge` 传入，注入 `{{domainKnowledge}}` 占位符

`main.ts` 生成调用处加载一次并传入 `generateRefinedFlow`；`buildAutoSanitizePrompt`/`buildRefinePrompt` 新增 `domainKnowledge` 值（无 skill 时为 `"(none)"` 显式标记）。占位符在两个生成模板中位于源材料之前、规则之后。预算：skills 合计 10,000 字符（与既有预算求和后仍受 100k 总量钳制）。`ai-refine.ts` 保持无 fs、无 Electron。备选「把 configDir 传进 ai-refine 自读」被否：破坏该模块的可测性与关注点分离。

### D4 frontmatter 用手写轻量解析

只认 `---` 围栏块内的 `name:` / `description:` 两个标量行（YAML 子集），缺失或块缺失即报错并指明文件。不引 gray-matter/js-yaml：Pi SDK 虽为 external 依赖，但项目自身不新增包依赖；两个字段的解析不值得引库。扫描规则与 Agent Skills 惯例对齐：目录含 `SKILL.md` 即为一个 skill，`README.md` 等其他文件忽略（因此 `config/skills/` 可放说明文件而不被误扫）。

### D5 方法论文字的落点与措辞

- systemPrompt 新增一段「Business-stage grouping method」：识别业务对象与其状态 → 三判据切组（交付物 / 状态变化 / 交接）→ 组名动词+对象 → 四层质量门 → 分支仅在其影响后续处理时创建。紧凑表述（增量约 1k 字符），置于 JSON 输出契约之后。
- 「Refined-material output contract」中 `rationale` 的语义扩展：每组一行完成标志（与组标签同语言）。
- 两个生成模板的「Business grouping」段改写为方法的应用层指引（autoSanitize 侧重录制清洗后的分组、refine 侧重在最小变更下重排分组），SSO 重构段与清理规则原样保留；质量门第四层写进两模板的 verification 段：仅当元素库存在结果证据时收尾验证，绝不发明。
- 措辞来源：SKL051 `references/Process与Instruction执行设计.md` 的拆分方法表与四层质量门（登录页可达/已认证/目标内容可见/业务操作已生效），映射到 FlowLink 既有结构（entry navigate / gate condition / 目标页 assert / 结果生效 assert）。

### D6 不预置知识文件，文档说明进 `docs/`

新增 `docs/pi-knowledge.md`：AGENTS.md 用途与预算、SKILL.md frontmatter 格式、目录约定、与 prompts.json 的分工（通用方法论 / 跨流程偏好 / 单系统业务知识）、示例片段。避免预置文件改变默认行为。

## Risks / Trade-offs

- [系统提示与模板变长，小模型输出稳定性下降] → 方法段紧凑、契约规则仍在其前；真机验证任务专门检查 JSON 契约与分组质量，必要时回退措辞而非结构。
- [知识文件内容与输出纪律冲突（如 skill 指示写选择器）] → AGENTS.md 追加段与 skills 段带固定框架语「在输出契约内适用，不可覆盖 $ref/变量规则」；校验管线（再水化 + parseFlow）本就兜底拒绝违规输出。
- [每次请求读盘开销] → 知识文本合计 ≤18k 字符、本地小文件，与 prompts.json 每请求读盘现状一致。
- [打包后 config 位于 asar 内只读，用户无法自助添加知识文件] → 与 prompts.json 现状一致；文档注明该限制，userData 层叠留待后续 change。
- [与 `refine-confirm-redesign`（进行中、未提交）同仓并行] → 两者改动面不重叠（该 change 不触碰 generation 模板与本设计的加载代码；本 change 不触碰 pending/意图判定）；执行会话需在其之后基于最新工作区实施。

## Migration Plan

纯增量变更，无数据迁移、无 schema/IPC 兼容性问题。回滚 = revert 对应提交（不写 AGENTS.md/skills 时行为与现状完全一致，风险面为零）。验证按项目门槛：`npm run build` + `npx tsc --noEmit`，加一条真机 refine 验证任务。
