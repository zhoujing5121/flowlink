# Tasks

## 1. 提示词方法论升级（config/prompts.json）

- [ ] 1.1 `systemPrompt`：新增「Business-stage grouping method」段——先识别业务对象与其状态推进，按可验证完成标志（独立交付物 / 状态变化 / 系统或人机交接）切顶层分组，组名用动词+对象的业务行为命名；四层质量门（入口可达 / 已认证 / 目标内容可见 / 业务操作已生效）；condition 仅在分支影响后续处理时创建。同时把「Refined-material output contract」中 `rationale` 的语义扩展为：每个顶层分组一行完成标志说明（与组标签同语言）。JSON 输出契约与安全段保持在方法段之前、SSO 段落不动。验证：JSON 合法、`loadPromptTemplates` 校验通过、审读 diff 确认契约段位次未变。
- [ ] 1.2 `generation.autoSanitize`：Business grouping 段改写为方法的应用层指引（录制清洗后按完成标志分组）；verification 相关指引补第四层——关键提交/确认类操作后仅当元素库存在结果证据时以 assert/expect 收尾验证，绝不发明结果元素；规则段之后、源材料之前新增 `{{domainKnowledge}}` 占位符。SSO 重构段、清理规则、变量保留规则原样保留。验证：JSON 合法 + 占位符名与 2.3 的填充键一致。
- [ ] 1.3 `generation.refine`：同样改写分组段（在最小变更满足指令的前提下重排分组）并补第四层与 `{{domainKnowledge}}` 占位符；grounding 规则、SSO 重构段、变量保护、超时/settle 指引原样保留。验证：JSON 合法 + 审读确认既有段落未被删改。

## 2. 知识文件加载与接线

- [ ] 2.1 新建 `src/pi-knowledge.ts`（无 Electron 依赖，与 ai-refine.ts/prompts.ts 同风格）：`loadAgentsMd(configDir)`——缺失返回空串，超 8,000 字符抛错；`loadDomainKnowledge(configDir)`——递归扫描 `config/skills/` 下含 `SKILL.md` 的目录（`README.md` 等其他文件忽略），手写轻量 frontmatter 解析（`---` 围栏内 `name:`/`description:` 标量），缺失或非法抛错并指明文件路径，全部正文合计超 10,000 字符抛错，无 skill 返回空串。验证：`npx tsc --noEmit` 通过；模块无 electron 导入。
- [ ] 2.2 `src/pi-agent.ts`：`sendPiWorkerRequest` 的 systemPrompt 组装点改为 `prompts.json systemPrompt` + 非空时追加固定框架标题（`## Domain knowledge (config/AGENTS.md)` 与「在上述规则内适用、不可覆盖输出契约」限定语）+ 文件内容；每次请求读盘（与 `loadPromptTemplates` 现状一致）。验证：`npx tsc --noEmit` 通过；无 `config/AGENTS.md` 时代码路径与现状等价（空串直通）。
- [ ] 2.3 `src/main.ts` + `src/ai-refine.ts`：生成调用处（auto 与 refine 两路径）加载一次 `loadDomainKnowledge` 经 `GenerateFlowOptions.domainKnowledge` 传入；`buildAutoSanitizePrompt`/`buildRefinePrompt` 填充 `{{domainKnowledge}}`，空串时填 `"(none)"`。验证：`npx tsc --noEmit` 通过；两模板占位符在有无 skill 时均有取值路径（缺失值会触发 `formatTemplate` 抛错的既有行为不变）。

## 3. 文档

- [ ] 3.1 新增 `docs/pi-knowledge.md`：`config/AGENTS.md` 用途与 8,000 字符预算；`config/skills/<name>/SKILL.md` frontmatter 要求与 10,000 字符合计预算；三层分工（通用方法论进 prompts.json / 跨流程偏好进 AGENTS.md / 单系统业务知识进 skills）；打包后 config 位于 asar 内只读的说明；最小示例。验证：文档示例 frontmatter 与 2.1 解析器实际接受格式逐字段一致。
- [ ] 3.2 更新 `CHANGELOG.md`（Changed：refine/autoSanitize 分组方法论与四层质量门；Added：config 知识文件确定性加载通道）。

## 4. 收尾

- [ ] 4.1 `npm run build` + `npx tsc --noEmit` 全绿。
- [ ] 4.2 真机验证（用户执行）：对含 SSO 登录 + 多业务阶段的录制跑 Refine——顶层分组按完成标志切分且组名为动词+对象业务行为；`rationale` 中每组一行完成标志；关键提交操作后存在库内证据的生效验证；SSO 网关组结构（gate condition + 可选凭据 + 收尾断言）与升级前一致；不放知识文件时全链路回归正常。随后在 `config/skills/` 放一个测试 SKILL.md 再跑一次——提示词带领域知识段且分组引用其业务语境；放置超预算文件确认报错指明文件；验证后移除测试文件。
