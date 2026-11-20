# Tasks

## 1. 提示词方法论升级（config/prompts.json）

- [ ] 1.1 更新 systemPrompt：新增 Business-stage grouping method——识别业务对象与状态推进，按可验证完成标志（独立交付物 / 状态变化 / 系统或人机交接）切分顶层分组；组名采用动词+对象；落实四层质量门（入口可达 / 已认证 / 目标内容可见 / 业务操作已生效）；仅在分支影响后续处理时创建 condition。扩展 rationale 契约：每个顶层分组一行完成标志说明，语言与组标签一致。保持 JSON 输出契约与安全段优先、SSO 规则不变。验证：JSON 合法、loadPromptTemplates 校验通过。
- [ ] 1.2 更新 generation.autoSanitize：将分组段改为按完成标志分组；第四层只在元素库存在结果证据时验证，不得发明结果元素；保留 SSO 重构、清理、变量和 $ref 规则。验证：审读 diff 确认既有规则未丢失。
- [ ] 1.3 更新 generation.refine：按用户指令并以最小变更优化分组；同样落实第四层证据验证；保留 grounding、SSO、变量保护及 timeout/settle 指引。验证：审读 diff 确认既有规则未丢失。

## 2. Pi 配置来源与 AGENTS.md

- [ ] 2.1 建立轻量 Pi 配置来源边界（例如 PiConfigSource + BuiltInPiConfigSource，命名遵循现有代码风格），集中提供 prompts、AGENTS.md 与内置 Skills 元数据/路径。当前实现只读取应用内置 config/ 文件；调用方不再散落直接读取。不要引入数据库、用户级配置、网络 API、管理员身份或角色权限系统。验证：配置来源模块可独立测试，未配置可选文件时保持默认行为。
- [ ] 2.2 在配置来源中加载可选 config/AGENTS.md，缺失返回空内容，超过 8,000 字符显式失败。验证：路径固定在应用内置 config 根目录；不接受外部路径或用户目录覆盖。
- [ ] 2.3 更新 src/pi-agent.ts：在 sendPiWorkerRequest 的中心 systemPrompt 组装点追加 AGENTS.md 固定框架段，明确其不能覆盖系统规则、输出契约或工具权限；对现有 runPiPrompt 调用一致生效。验证：无 AGENTS.md 时与现状等价；advice 等现有调用仍能获得 AGENTS.md，但不获得 Skills。

## 3. Pi 原生 Skills 与严格权限模式 A

- [ ] 3.1 从内置 config/skills/**/SKILL.md 加载 Skills；校验 frontmatter 的 name/description、命名规则、重复名称和路径；拒绝 allowed-tools 与 shell 命令插值。不要把 Skill 正文整体注入 generation prompt。建议上限：描述合计 8,000 字符、单个 SKILL.md 10,000 字符、每请求最多 3 个 Skills。验证：合法 Skill 被发现；非法/重复 Skill 明确报错。
- [ ] 3.2 在 src/pi-agent-worker.ts 接入 Pi 原生 Skills：关闭默认/用户/项目 Skills 发现，通过 skillsOverride 或 SDK 1.5.1 中等效受控入口只提供内置 Skills。验证 noSkills 与 override 的组合；确认默认 home/project Skills 不会被发现。
- [ ] 3.3 实现唯一自定义受限 read 工具：只允许读取内置 Skill 根目录下的 SKILL.md 和明确列入 Skill 包的纯文本参考文件；拒绝目录外路径、绝对路径、路径穿越、符号链接逃逸、目录读取、二进制、脚本和可执行文件。对单次读取及每请求累计读取量限额（建议累计 20,000 字符）。验证：路径穿越、编码绕过、符号链接、外部绝对路径、脚本/二进制均被拒绝。
- [ ] 3.4 在 SDK 锁定版本 1.5.1 上验证 noTools: "builtin"、tools allowlist 与 customTools 的组合，确保最终模型可调用工具只有受限 read；确认 Bash/PowerShell/Write/Edit/Grep/Find/LS 不可用。若内置 read 冲突，改用 Skill 专用读取工具；不得开放默认 read 或 shell。验证：自动化断言最终工具注册表。
- [ ] 3.5 仅在真实的 pi:generateFlow 与 pi:repairFlow 请求路径启用 Skills；advice、takeover、prewarm 不加载 Skills。不得把模板名 autoSanitize 当作自动触发入口，不恢复录制完成后的自动 refine。验证：分别检查上述调用路径的 resource loader 配置与 Skill 列表。

## 4. 文档与变更记录

- [ ] 4.1 新增 docs/pi-knowledge.md：说明 prompts.json / AGENTS.md / Skills 分工、内置 Skill 目录与 frontmatter、严格 read 允许/拒绝范围、预算、示例及打包配置限制；说明未来管理员配置页可复用配置来源边界，但管理员页面、用户账号、角色/RBAC 和权限管理均不属于本 change。
- [ ] 4.2 更新 CHANGELOG.md：记录业务阶段分组方法论与四层质量门，以及 Pi 原生内置 Skills 的严格只读能力和配置来源边界。

## 5. 验证与收尾

- [ ] 5.1 npm run build 与 npx tsc --noEmit 全绿。
- [ ] 5.2 单元/集成测试：Skills 只来自内置目录；默认/home/project Skills 不加载；无 Skills 时行为不变；frontmatter 非法、重复名称和超预算明确失败；read 只能访问 allowlist；所有越权路径与脚本执行均被拒绝。
- [ ] 5.3 调用范围测试：生成/修复能发现并按需读取 Skill；advice/takeover/prewarm 不加载 Skills；AGENTS.md 仍按设计作用于现有 runPiPrompt 调用。
- [ ] 5.4 真机验证（用户执行）：对含 SSO 登录与多业务阶段的录制执行 Refine/Repair，检查按完成标志分组、组名业务化、rationale 完成标志、第四层仅基于元素库证据，以及 SSO 网关结构与升级前一致；再用一个内置测试 Skill 验证按需读取与业务知识应用。移除测试 Skill 后确认默认流程正常。
