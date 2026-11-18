# Replay Execution Specification

## Purpose

执行器契约：串行执行已校验 Flow、条件分支与循环上限、可选步骤自适应、等待/断言预算、settle 约定、Pending/Skipped 状态语义、自愈写回、前缀回放与批量回放（引擎能力）。

## Requirements

### Requirement: The executor SHALL run steps serially and produce per-step evidence and a run report

The executor SHALL execute a validated Flow serially and write per-step evidence plus a run report.

执行器接受已校验 Flow 与种子 Playwright 页面（可含额外页面），逐步执行并上报状态；每步落 before/after 截图、snapshot 与日志，运行结束写 `result.json` 到 `runs/<runId>/`；取消由 abort 信号驱动；`stopOnFailure` 开启时首个失败即结束并保留其报告与工件供诊断。回放按执行器常规模板变量解析取值；上传文件保持 Reference 条目、不注入为运行时变量；密钥值只传入该次回放、不存入 Flow。

#### Scenario: 失败保留证据
- **WHEN** stopOnFailure 下某步失败
- **THEN** 运行在该步结束，失败步骤的截图/快照/日志完整落盘

### Requirement: Condition steps SHALL route to existing groups under a three-visit loop limit

Condition steps SHALL route execution to existing groups, bounded by a three-visit loop limit per top-level group.

条件步骤把断言求值为布尔（`EXPECT_MISMATCH` 视为 false，其余错误照常抛出）并跳转扁平游标到目标分组开头；无目的地则结束该分支；每个分组每次运行最多进入 3 次，第 4 次以 `FLOW_LOOP_LIMIT` 失败终止（即使 stopOnFailure 关闭）。被跳过的步骤以 `skip` 结果上报；条件步骤保持瞬时求值。

#### Scenario: 循环上限
- **WHEN** 分支组合使同一分组第 4 次进入
- **THEN** 运行以 FLOW_LOOP_LIMIT 失败终止

#### Scenario: 分支跳过上报
- **WHEN** 条件跳转到后置分组
- **THEN** 被跳过区间的步骤在报告中为 skip 状态

### Requirement: isOptional steps SHALL adapt to replay-time state and report skip instead of failing

`isOptional` steps SHALL adapt to replay-time state and report skip instead of failing.

可选 `navigate`：等待 800ms 后比较当前 URL 的 origin+pathname 与录制的 `previousUrl`（`sameSitePath`，忽略查询串与 hash——SSO 往返携带每次运行的 state 参数）；浏览器已自行跳转则报 skip，否则执行导航。可选元素步骤（input/select/click/hover/upload）：目标在短等待内未出现即报 skip。由此门条件 + 容忍式登录组可同时覆盖已登录、过期与记忆式 SSO 状态。

#### Scenario: 已自行跳转的 SSO
- **WHEN** 回放时浏览器已因会话完成 SSO 跳转
- **THEN** 可选 navigate 步骤报 skip，不产生失败

#### Scenario: 记忆式登录
- **WHEN** 容忍式登录组的凭据步骤目标未出现
- **THEN** 该可选元素步骤报 skip，组尾断言继续判定

### Requirement: Expect and assert checks SHALL poll within a bounded budget

Expect and assert checks SHALL poll within a bounded wait budget with capped in-poll resolves.

expect/assert 默认轮询 5 秒，轮询内每次元素解析限时 1 秒以保证预算成立（慢解析不再独吞等待预算）；步骤 `timeout` 字段可覆盖等待（钳制 1–30 秒），条件步骤保持瞬时。`condition: "userOperation"` 的 wait 经宿主回调暂停，桌面壳以带一次性 token 的 `playback:userOperation` 事件请求确认、`playback:continueUserOperation` 恢复，过期 token 被拒；中止回放即拒绝该等待。

#### Scenario: 慢过渡断言
- **WHEN** SSO 后的首个检查设置 timeout 15000
- **THEN** 断言按 15 秒预算轮询，而非默认 5 秒失败

### Requirement: The settle contract SHALL wait for page stability before a step, best-effort

A step with `settle` SHALL wait for page stability before resolving elements or executing the action, on a best-effort basis that MUST NOT fail the step.

`networkIdle: true` 等 Playwright networkidle；`domQuietMs` 注入 MutationObserver（独立 `__rrSettle*` 全局，同样过滤 `data-rr-` 标记）轮询直到 DOM 静默该时长；两者共享一个 `maxMs` 预算（默认 10 秒）。命中预算只记录并继续——正确性交给后续元素等待与 expect/assert 检查，长轮询站点可容忍。`navigate`（自身已等 load + 尽力 networkIdle）与 `wait` 步骤跳过 settle；缺省该字段时回放行为与旧版一致。

#### Scenario: 预算命中不失败
- **WHEN** 长轮询页面使 domQuietMs 至 maxMs 都无法满足
- **THEN** 记录日志后继续执行该步骤

### Requirement: Action steps SHALL get a default lightweight post-action settle

Action steps SHALL get a default lightweight post-action settle before expect checks, so fast SPA pages finish updating first.

动作步骤（click/input/select/key/hover/drag/upload）完成后默认等待 DOM 静默 350ms（上限 2.5s，日志记为 post-settle）再进入 expect 检查。

#### Scenario: SPA 更新先完成
- **WHEN** 某动作执行后页面仍在局部更新
- **THEN** post-settle 等 DOM 静默后再执行期望检查

### Requirement: Step results SHALL preserve Pending versus Skipped semantics

Step results SHALL preserve the distinction between unreached Pending steps and engine-skipped Skipped steps.

引擎主动跳过的步骤（未走的条件分支、未生效的 isOptional）以 `skip` 上报；运行未到达的步骤在失败、AI 接管结束或执行错误后保持 Pending（未执行，运行停在那里）。结果按步骤 id 匹配（旧数据回退到达顺序）；`playback:done` 也按 id 对齐最终状态。

#### Scenario: 失败后未达步骤
- **WHEN** 回放在第 3 步失败
- **THEN** 第 3 步及之后的步骤保持 Pending，此前被跳过的步骤保持 Skipped

### Requirement: Self-healing SHALL stay separate from observed facts and write back only when enabled

Self-healing SHALL stay separate from observed facts and write back only when explicitly enabled.

自愈只更新 resolution 数据；`writeBack=true` 且提供 flow 路径时才写回，成功写回创建 `.bak` 副本并递增 flow 版本。L4（AI 修复）保持为执行器侧钩子，桌面端不注入——失败步骤结束运行，剩余步骤由用户手动交给 AI 接管（见 ai-integration）。

#### Scenario: 写回开关
- **WHEN** 未提供 flow 路径或 writeBack 未开启
- **THEN** 自愈结果仅存在于本次运行，不改动 Flow 文件

### Requirement: Prefix replay SHALL validate an in-memory prefix Flow without touching run metadata

Prefix replay SHALL execute a validated in-memory prefix Flow without changing the saved flow or its run metadata.

`prefixSteps()` 保留原分组/控制流结构（而非切片扁平列表）并丢弃落在前缀外的分支目标；临时 Flow 先经 schema 解析再执行。重录与 Add-before 重放所选分组之前的扁平步骤，Add-after 重放至该组末尾。成功后浏览器停留在到达状态，录制以 `preservePage=true` 附着当前文档而不重载；播放创建的页面映射回原生标签页 ID，执行器为下一段录制报告最终活动页索引；前缀失败则返回既有 Process 视图、不启动新录制。

#### Scenario: 组前重录
- **WHEN** 用户选择在某分组前重新录制且前缀回放成功
- **THEN** 无刷新接入录制，当前标签页与页面状态保留

### Requirement: Batch replay SHALL run one Flow across isolated per-row contexts

Batch replay SHALL run one Flow across isolated per-row contexts under one browser launch (engine capability).

每个 CSV 变量行获得带共享 storage state 的全新隔离上下文；行工件落在 `artifacts/<flowId>/batches/<batchId>/row-<index>/`；`VARIABLE_MISSING` 渲染错误只失败该行；abort 在行间生效；循环控制与聚合为纯函数。该能力尚未在桌面壳暴露——CSV 导入与批量运行视图属未来工作。

#### Scenario: 单行变量缺失
- **WHEN** 某行缺少必需变量
- **THEN** 仅该行失败，其余行继续执行
