# Pi 领域知识配置（prompts / AGENTS.md / Skills）

FlowLink 通过一个统一的 **Pi 配置来源边界**（`src/pi-config.ts`，`PiConfigSource`）集中读取并校验三类应用内置配置。当前唯一实现是应用内置 `config/` 目录；Pi worker 的安全边界只依赖这个边界提供的校验结果，未来管理员配置页可以接入同一边界，而不需要重写 worker 的工具白名单。

> 范围说明：管理员配置页面、用户账号、角色/RBAC、权限管理、用户级配置覆盖与远程配置同步均**不在当前范围**；打包后 userData 层叠覆盖配置如需支持，另立 change。

## 配置分工

| 来源 | 作用 | 生效范围 |
| --- | --- | --- |
| `config/prompts.json` | 系统提示（`systemPrompt`）与各场景模板（generation.autoSanitize / generation.refine / advice / takeover） | 全部 Pi 调用；模板占位符缺失即报错 |
| `config/AGENTS.md`（可选） | 领域知识（业务术语、系统编码习惯等） | 全部 `runPiPrompt` 调用：在 `sendPiWorkerRequest` 中心组装点以带标题的「Domain knowledge」段追加到 systemPrompt 末尾 |
| `config/skills/<name>/SKILL.md` | 内置 Skills（业务域知识文档），经 Pi 原生 Skills 机制按需读取 | **仅** `pi:generateFlow` 与 `pi:repairFlow` 两个生成入口；advice、takeover、prewarm 不加载 |

## AGENTS.md

- 缺失时为空操作，行为与现状一致。
- 上限 **8,000 字符**，超限 Pi 请求显式失败（不静默截断）。
- 追加段带固定限定语：内容是参考资料，**不能**覆盖系统规则、输出契约、元素引用纪律或工具权限；worker 的资源加载限制不因该文件放松。

## 内置 Skills

### 目录与发现

- 只从应用内置 `config/skills/` 树发现：任何含 `SKILL.md` 的目录即一个 Skill 根（该目录内不再下钻）；支持嵌套（如 `config/skills/domain/<name>/SKILL.md`）。
- 默认/用户（home `~/.pi/agent/skills`）/项目（`<cwd>/.pi/skills`）目录的 Skills 自动发现始终关闭；生成会话通过 Pi SDK `DefaultResourceLoader` 的 `skillsOverride` 只注入 FlowLink 校验过的内置 Skills（`noSkills: true` 与 override 组合在 SDK 1.5.1 已验证：override 恒被应用）。
- 不预置示例 Skill；`config/skills/` 缺失或为空时生成会话不含 Skills 提示段，行为与现状一致。
- Skill 正文**绝不**拼接进生成提示词；模型经受限 `read` 工具按需读取。

### SKILL.md 格式（严格子集）

```markdown
---
name: order-ops
description: Knowledge about the order management business domain.
references:
  - notes.txt
  - deep/guide.md
---

（正文：业务域知识，供模型按需读取）
```

frontmatter 规则（违规即显式失败并点名文件路径，绝不静默跳过或截断）：

- `name`：必填；小写字母/数字/连字符，≤64 字符，不以连字符开头/结尾、无连续连字符。
- `description`：必填非空，≤1,024 字符；**所有 Skill 的 description 合计 ≤8,000 字符**（内置 Skills 规模由此预算兜底，不设个数上限）。
- 单个 `SKILL.md` 文件 ≤10,000 字符。
- 只支持逐行 `key: value` 与 `references:` 下的 `- item` 列表；多行值、锚点、内联结构等复杂 YAML 语法一律报错。
- `allowed-tools` 键一律拒绝；任何 frontmatter 值含 `$(...)` 或反引号命令替换一律拒绝（Skill 不能改变工具权限或要求执行命令）。
- `references`（可选）：明确列入 Skill 包的纯文本参考文件，**只能**是 Skill 目录内的相对路径、扩展名 `.md`/`.txt`、实际存在且非符号链接逃逸；重复条目报错。
- Skill 名称重复报错（点名两个冲突文件）。

## 受限 read 工具（严格模式 A）

生成会话（`pi:generateFlow` / `pi:repairFlow`）的工具配置：

- `noTools: "builtin"` 剔除全部内置工具（保留 customTools），`tools: ["read"]` allowlist 只留 `read`，再注册**唯一**自定义受限 `read` 工具；创建会话后自动化断言最终工具注册表**仅含**这一个 read。断言失败属阻塞缺陷：重新评估设计，不得改名绕过、不得开放默认 read。
- 工具名锁定为 `read`：Pi 系统提示构建器只在会话声明名为 `read`/`bash` 的工具时注入原生 Skills 提示段（readers 列表硬编码），改名会使 Skills 对模型完全不可见，因此不存在「改名回退」路径。
- 允许读取的范围**仅限**内置 Skill 根目录下的 `SKILL.md` 与 frontmatter `references` 列入的纯文本参考文件（真实路径 allowlist）。
- 拒绝：目录外路径、路径穿越（`..`）、符号链接逃逸、外部绝对路径、目录读取、二进制内容（NUL 检测）、一切脚本/可执行扩展名（allowlist 只收 `.md`/`.txt`）、编码绕过（百分号编码路径解析不到真实文件即拒绝）。
- 预算：单次读取与每请求累计读取（合计 **20,000 字符**）超限即拒绝并明确提示预算已尽，**绝不静默截断**内容。
- 不注册 Bash、PowerShell、Write、Edit、Grep、Find、LS；Skill frontmatter 或正文不能改变工具白名单。录制数据、页面文本与 Skill 内容均按不可信证据对待，仅作参考资料。

## 会话模式一览

| 调用 | Skills | 工具 |
| --- | --- | --- |
| `pi:generateFlow` / `pi:repairFlow`（生成模式） | 内置 Skills（skillsOverride 注入） | 仅受限 `read` |
| advice 等其余 `runPiPrompt`（文本模式） | 无 | `noTools: "all"`，无任何工具 |
| prewarm | 无 | 无（只预热运行时缓存） |

## 验证方式

- `npm run build`、`npx tsc --noEmit`、`npm test`（node --import tsx --test；含 `tests/pi-knowledge.test.ts` 永久回归：Skills 只来自内置目录、默认/home/project 不加载、frontmatter 违规/重名/超预算显式失败、read allowlist 与越权路径拒绝、生成会话工具注册表断言）。
- 真机验证（用户执行，见 openspec change 任务 5.4）：用含 SSO 登录与多业务阶段的录制跑 Refine/Repair，检查按完成标志分组与四层质量门；再放入一个测试 Skill 验证按需读取与业务知识应用，移除后确认默认流程正常。

## 打包限制

当前配置只读应用内置 `config/` 目录；打包后修改这些文件即修改应用行为，尚无 userData 层叠覆盖或管理界面（后续如需支持，另立 change）。
