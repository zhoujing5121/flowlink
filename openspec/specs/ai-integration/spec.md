# AI Integration Specification

## Purpose

Pi 编码代理集成契约：worker 会话与受限环境、prompts.json 模板、细化生成管线（投影/提示/重水化/校验）、录制后自动细化、失败后的 AI 接管（全量/单步续跑/自由降级）、接管证据与自动修复回跑、代理与自定义端点。

## Requirements

### Requirement: Pi sessions SHALL run in an on-demand worker thread with a restricted environment

Pi sessions SHALL run in an on-demand Node worker thread with a restricted environment.

Pi SDK（`@earendil-works/pi-coding-agent`，不 spawn pi CLI）懒生成、空闲时 `unref`、超时终止、应用退出销毁；每次请求前校验设置与凭据形状；提示尺寸上限 100,000 字符；请求超时钳制 [5s, 600s]；渲染请求与 worker 响应按 id 关联。worker 内在导入 SDK 前安装 Undici `EnvHttpProxyAgent` 为全局 dispatcher；SDK 会话使用内存 session manager 与受限 `DefaultResourceLoader`（扩展、技能、提示模板、主题、上下文文件全部禁用），强制注入 FlowLink 系统提示，`noTools: "all"` 仅文本；模型运行时按 (auth path, provider, model) 缓存并在失败后重建。录制数据与页面文本按不可信证据对待，绝不作为指令。

#### Scenario: 超时终止
- **WHEN** 一次 Pi 请求超过钳制后的超时
- **THEN** worker 被终止并返回错误，请求不悬挂

#### Scenario: 提示注入防护
- **WHEN** 页面文本中包含指令样内容
- **THEN** 只作为证据参与提示，模型无工具、无执行能力

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

未知 id 与内联元素对象被拒并点名违规步骤；库条目深克隆回填使 observed 证据逐字节还原；缺失步骤 id 生成、冲突加 `-2`/`-3` 后缀。校验经 `parseFlow`（含 v2 契约），变量自所有源合并、首个非密钥默认值胜出。校验后的 Flow 作为提案返回，此处从不落盘——持久化只经用户驱动的 `recording:persistMerged` 保存为全新录制（`isMerged: true`，永不覆盖既有录制，非法输出在持久化关口被拒）。

#### Scenario: 拒绝内联元素
- **WHEN** 模型输出携带内联元素对象
- **THEN** 重水化拒绝并点名违规步骤

#### Scenario: 证据逐字节还原
- **WHEN** 提案步骤重水化完成
- **THEN** 其 observed 证据与源录制逐字节一致

### Requirement: Auto-refine SHALL create a REFINED twin without touching the source recording

Auto-refine SHALL create a `REFINED…` twin through the shared pipeline without touching the source recording.

录制持久化后主进程 fire-and-forget 触发（in-flight 集合防重、`autoRefine` 默认开、`config/pi-settings.json` 中 `autoRefine: false` 关闭、`isMerged` 源排除）；经共享合并持久化路径保存（重名追加 ` (2)`/` (3)`）；`ai:autoRefine` 事件上报 done/failed/skipped（未配置 Pi 时 silent）。Pi worker 顺序处理提示，在途建议调用只是推迟孪生。

#### Scenario: 自动孪生
- **WHEN** 一次录制保存且 Pi 已配置
- **THEN** 后台生成 REFINED 孪生录制，原录制不变，事件驱动列表刷新与 toast

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce business-stage grouping, plain-language labels, and verification/branching invariants.

强制 2–6 个带标签顶层业务分组与非技术用户可懂的步骤标签；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle；登录段保持门条件 + 容忍式登录组（可选凭据步骤收尾断言）以适配已登录/过期/记忆式 SSO；录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板，未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

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

每步从活动页面采集可交互元素的 tag/role/name/testid 写入 `ai-takeover.json`；自动修复把证据注入细化指令，并为元素库中匹配到的元素前置 `source: "ai"` 重锚候选（置于录制候选链之前；observed 证据保持不可变，输出仍通过完整 schema 契约）。接管结束后流程在后台自动优化并经校验持久化契约保存为新的 `REPAIRED-…` 录制——原 Flow 及其测试结果不动、无按钮（进度与修复摘要落 AI 面板）；细化往返保留 `execution`/`settle`/`sourceFlowId` 字段而非静默丢弃。

#### Scenario: 证据采集
- **WHEN** 代理完成一个步骤
- **THEN** 该步元素证据写入 ai-takeover.json，不含任何输入值

### Requirement: A repair SHALL automatically re-run the test on the repaired flow at most twice

A repair SHALL automatically re-run the test on the `REPAIRED-…` flow at most two rounds, leaving the original recording untouched.

Test 进度头显示「· 自动回跑 N/2」徽章并在 AI 面板提示。

#### Scenario: 修复孪生
- **WHEN** 接管结束
- **THEN** 后台生成 REPAIRED-… 新录制并自动回跑测试（≤2 轮），原录制与其结果不变

### Requirement: Provider requests SHALL honor proxy configuration and custom endpoints

Provider requests SHALL honor proxy configuration and custom OpenAI-compatible endpoints.

worker 内代理经 `EnvHttpProxyAgent` 遵守 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（浏览器流量单独配置）；`--pi-system-proxy` 解析 Windows 代理/PAC 用于模型端点，`--pi-proxy=<URL>` 显式指定 HTTP/HTTPS/SOCKS5 代理；支持经 `config/models.json` 的通用 `custom` provider。Pi 配置位于工件树之外：`config/pi-settings.json`（provider/model/thinking/timeout 默认）与凭据 `config/pi-auth.json`（开发期）/`<userData>/pi-auth.json`（打包后）；凭据文件是密钥，永不提交、记录或打包。

#### Scenario: 显式代理
- **WHEN** 以 `--pi-proxy=socks5://…` 启动应用
- **THEN** 模型端点请求经该代理发出
