# Proposal

## Why

Refine/autoSanitize 的分组质量不稳定：现有提示词缺少可操作的业务阶段切分判据，容易按页面或技术特征分组。需要补充经过验证的业务对象追踪、完成标志切组和分层质量门方法。

同时，FlowLink 需要为 Pi 提供可按需读取的业务域知识。此前拟议的「把所有 Skill 正文拼接进生成提示词」不符合用户选择的 Pi 原生 Skills 方向，也会增加每次请求的提示词体积。现改为接入 Pi 原生 Skills，并严格限制其文件读取能力。

## What Changes

- **分组方法论升级**：在 systemPrompt 与 `generation.autoSanitize` / `generation.refine` 中明确业务对象状态推进、按可验证完成标志（独立交付物 / 业务对象状态变化 / 系统或人机交接）切分组、动词+对象命名、四层质量门（入口可达 → 已认证 → 目标内容可见 → 业务操作已生效），以及仅在影响后续处理时创建条件分支。每组完成标志写入现有 `rationale`，不改 Flow schema。
- **保留既有生成纪律**：SSO 登录段识别与网关重构、无用步骤清理、变量模板保护、`$ref` 元素纪律、慢过渡 timeout/settle 指引均保留。
- **Pi 原生 Skills（严格模式 A）**：
  - 仅从应用内置的 `config/skills/<name>/SKILL.md` 加载 Skills，并通过 Pi SDK 的原生 Skills 机制向模型提供 Skill 名称和描述。
  - 保持默认 Skills 发现关闭；通过受控的 Skills override 提供经过 FlowLink 校验的内置 Skills。
  - Pi 只获得一个自定义 `read` 工具。该工具只允许读取内置 Skill 目录中的 Skill 文件/明确允许的文本参考文件；拒绝目录外路径、路径穿越、符号链接逃逸、二进制和脚本文件。
  - 禁用所有其他内置工具及脚本执行能力；不提供 Bash、PowerShell、Write、Edit、Grep、Find、LS 等工具。严格权限不能由 Skill frontmatter 或 Skill 正文改变。
  - 对锁定的 Pi SDK 版本验证 `noTools: "builtin"`、自定义 `read` 工具和 `skillsOverride` 的组合行为；若存在工具冲突，采用等效的显式自定义 Skill 读取机制，不得回退开放通用文件读取。
- **Skills 的启用范围**：只在当前实际存在的生成和修复请求中启用 Skills（`pi:generateFlow`、`pi:repairFlow`）；advice、takeover、prewarm 不加载 Skills。当前 `autoSanitize` 是生成模板，不代表存在录制后自动触发流程；本 change 不恢复自动细化。
- **AGENTS.md 与 Prompts 配置**：`config/AGENTS.md` 继续作为 Pi 全局指导内容，在中心 systemPrompt 组装点追加，作用于现有 `runPiPrompt` 调用；`config/prompts.json` 继续承载系统提示与各场景模板。
- **配置来源边界（为未来预留，不扩范围）**：将 Prompts、AGENTS.md、Skills 的读取与校验收敛在一个小型 Pi 配置来源接口/模块后面。当前唯一实现是应用内置 `config/` 文件，保持现有默认行为；未来管理员配置页可以接入同一边界。当前不实现管理员页面、用户账号、角色、权限管理、远程配置或用户级覆盖。
- **不可信内容边界**：录制数据、页面文本、Skill 内容均视为数据/参考资料，不得覆盖系统提示、输出契约、元素引用纪律或工具白名单。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ai-integration`：
  - 更新生成提示词的业务分组与验证不变量。
  - 更新 Pi 受限会话要求：只暴露受控的 Skill 文件读取能力，保持无脚本执行和无任意文件访问。
  - 新增 Pi 配置来源边界与内置 Skills 加载/校验契约；AGENTS.md 仍在中心提示词组装点追加。

## Impact

- `config/prompts.json`：更新 systemPrompt 与两个生成模板中的分组方法论。
- `config/AGENTS.md`、`config/skills/<name>/SKILL.md`：作为应用内置配置来源；不预置示例文件以免改变默认行为。
- `src/pi-agent.ts`：在现有中心 systemPrompt 组装点追加 AGENTS.md。
- `src/pi-agent-worker.ts`：配置 Pi 原生 Skills override、受限自定义 `read` 工具和工具 allowlist。
- 新增或调整轻量 Pi 配置模块：集中读取/校验 Prompts、AGENTS.md、Skill 元数据及内置 Skill 路径；不把 Skill 正文整体注入生成模板。
- `src/main.ts`：只在 `pi:generateFlow` 与 `pi:repairFlow` 请求路径传递受控 Skill 配置。
- 新增 `docs/pi-knowledge.md`：说明配置分工、Skill 格式、严格读取边界和未来配置来源扩展点。
- 不改 Flow schema、普通用户 UI、IPC 对外功能或 takeover 行为。

## Out of Scope

- 管理员配置页面、用户账号、角色/RBAC、权限管理及任何相关 UI/API。
- 管理员配置存储、用户级配置覆盖、远程配置同步。
- Pi extensions/plugins、Bash/PowerShell 或任意脚本执行。
- 任意项目文件、用户文件或系统文件读取。
- Skills 注入 advice、takeover 或 prewarm。
- 恢复录制完成后的自动 refine/autoSanitize 触发。
- Flow schema、渲染层分组 UI 与 `refine-confirm-redesign` 生命周期改动。
- 打包后 userData 层叠覆盖配置；后续如需支持，另立 change。
