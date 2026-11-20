# Proposal

## Why

Refine/autoSanitize 的分组质量不稳定：提示词只要求「2–6 个业务阶段分组、不按页面命名」，没有给出在哪里切分组的可操作判据，模型只能按页面 URL/技术特征猜测，产出偏技术切分而非业务阶段。参考 SKL051（bosch-moka skill）验证过的方法论——业务对象追踪 + 完成标志切组 + 四层质量门——可以补上这块判据；同时业务域知识（某系统的 SSO 流程、页面结构、术语）目前没有注入通道，方法论再好也缺乏业务上下文。

## What Changes

- **分组方法论升级（prompts.json 内容）**：systemPrompt 与两个生成模板（`generation.autoSanitize` / `generation.refine`）新增「业务阶段分组方法」——先识别业务对象与其状态变化，按**可验证的完成标志**（独立交付物 / 业务对象状态变化 / 系统或人机交接）切分组，组名用动词+对象的业务行为命名；四层质量门显式化（入口可达 → 已认证 → 目标内容可见 → **业务操作已生效**，第四层为新增：关键操作后基于元素库证据的结果验证）；条件分支收紧为「分支影响后续处理才创建」；每个分组的完成标志写入 `rationale`（渲染层已展示，零 schema/UI 改动）。
- **保留全部现有能力**：SSO 登录段识别与网关重构（gate condition + 容忍式凭据步骤 + 收尾断言）、无用步骤清理、变量模板保护、`$ref` 元素纪律、慢过渡 timeout/settle 指引原样保留——SKL051 的阶段 1（打开+登录+进列表合并进首个业务阶段）与现有 SSO 规则同构，互相印证而非推翻。
- **config 目录 Pi 知识文件（确定性加载）**：
  - `config/AGENTS.md`（可选）：存在时由主进程读取并追加到 Pi 会话系统提示末尾（带分隔标题与大小预算，超限响亮失败）；缺失时行为完全不变。作用于所有走 `runPiPrompt` 的调用（autoSanitize/refine/advice）。
  - `config/skills/<name>/SKILL.md`（可选）：FlowLink 递归扫描含 `SKILL.md` 的目录，解析 frontmatter 的 name/description，把全部 skill 正文作为新的 `{{domainKnowledge}}` 占位符段注入两个生成模板；总预算超限或 frontmatter 非法时显式失败（与现有预算哲学一致）。存放 SKL051 式「单业务系统的对象字典/阶段知识」。
  - 分工：通用方法论进 prompts.json，跨流程偏好进 AGENTS.md，单系统业务域知识进 skills/。
- **不改动 worker 资源加载**：`DefaultResourceLoader` 的 noExtensions/noSkills/noContextFiles 等限制全部保持——refine 会话是无工具会话，Pi 原生 skill「模型按需读文件」机制不可用，知识必须由主进程确定性内联；extensions（plugin）在无工具会话无执行面，维持禁用。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ai-integration`：
  - 修改 "Generation prompts SHALL enforce grouping and verification invariants"：在既有不变量之上增加业务对象追踪、完成标志切组判据、四层质量门（含业务操作生效验证）与分支最小化判据，并要求分组完成标志进入 rationale。
  - 修改 "Pi sessions SHALL run in an on-demand worker thread with a restricted environment"：注入的系统提示 = prompts.json `systemPrompt` + 可选 `config/AGENTS.md` 追加段（预算内）；worker 资源加载限制不变。
  - 新增 "Domain knowledge files SHALL load deterministically within hard budgets"：AGENTS.md 与 skills 的发现、校验、预算与缺失即无操作的行为契约。

## Impact

- `config/prompts.json`：systemPrompt 与两个生成模板内容重写；生成模板新增 `{{domainKnowledge}}` 占位符。
- `src/ai-refine.ts`：`buildAutoSanitizePrompt`/`buildRefinePrompt` 填充 `{{domainKnowledge}}`；新增知识文本预算检查。
- 新增 `src/pi-knowledge.ts`（或并入现有结构）：AGENTS.md 与 skills 的加载/校验（保持无 Electron 依赖、可测试）。
- `src/pi-agent.ts`：systemPrompt 组装点追加 AGENTS.md 段。
- `src/main.ts`：生成调用处传递知识文本。
- 新增可选文件：`config/AGENTS.md`、`config/skills/<name>/SKILL.md`（均缺失即无行为变化）；新增使用说明文档。
- 无 Flow schema、IPC、渲染层改动；与进行中的 `refine-confirm-redesign`（生命周期/确认交互）不重叠——其 Out-of-Scope 已明确排除生成模板内容调整。

## Out-of-Scope

- Pi extensions/plugins 启用与任何 worker 资源加载开关的变更（noExtensions/noSkills/noContextFiles 等维持现状）。
- Pi 原生 skill 发现机制接入（无工具会话读不了文件，本 change 用 FlowLink 侧确定性内联替代）。
- takeover（browser-use）链路的知识注入（其提示词组装独立，如需另立 change）。
- advice 模板的 skills 注入（advice 仅经系统提示获得 AGENTS.md；skills 只进生成模板）。
- 打包后 userData 层叠覆盖 config 知识文件（保持与 prompts.json 相同的 config 目录行为；打包场景定制另议）。
- Flow schema 变更：group 不加描述字段、不支持嵌套子组（完成标志走 rationale；SKL051 的三级拆分映射为「一级=group、二/三级=组内步骤」）。
- `refine-confirm-redesign` 涉及的 pending/Confirm/Discard 生命周期与意图判定（进行中 change，不触碰）。
- prompts/（slash 模板）、themes/ 等 Pi TUI 资源。
