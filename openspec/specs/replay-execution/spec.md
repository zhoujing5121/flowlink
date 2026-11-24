# Replay Execution Specification

## Purpose

执行器契约：串行执行已校验 Flow、条件分支与循环上限、可选步骤自适应、manual 步骤人工确认、等待/断言预算、settle 约定、Pending/Skipped 状态语义、回放前 Reference 校验闸门、自愈写回、前缀回放与批量回放（引擎能力）。

## Requirements

### Requirement: The executor SHALL run steps serially and produce per-step evidence and a run report

The executor SHALL execute a validated Flow serially and write per-step evidence plus a run report.

执行器接受已校验 Flow 与种子 Playwright 页面（可含额外页面），逐步执行并上报状态；每步落 before/after 截图、snapshot 与日志，运行结束写 `result.json` 到 `runs/<runId>/`；取消由 abort 信号驱动；`stopOnFailure` 开启时首个失败即结束并保留其报告与工件供诊断。回放按执行器常规模板变量解析取值；上传文件保持 Reference 条目、不注入为运行时变量；密钥值只传入该次回放、不存入 Flow。

#### Scenario: 失败保留证据
- **WHEN** stopOnFailure 下某步失败
- **THEN** 运行在该步结束，失败步骤的截图/快照/日志完整落盘

### Requirement: Condition steps SHALL route to existing groups under a three-visit loop limit

Condition steps SHALL route execution to any existing step or fall through sequentially, bounded by a three-visit loop limit per top-level group.

条件步骤可在组内任意位置出现（不限于组末）。求值为有界重试：在默认 4 秒窗口内每 300ms 重评一次（步骤 `timeout` 可覆盖并钳制到 [1000, 30000]），任一次匹配即判定为真；断言错误中 `EXPECT_MISMATCH` 视为 false，其余错误照常抛出。分支目标存在时把扁平游标跳到**目标步骤**（同 Flow 内任意已存在步骤，不再限于组开头）；分支缺省（未指定目标）时**顺序继续**（不跳转、执行组内下一步，两分支都缺省时仅记录判定结果后继续）；被跳过的步骤以 `skip` 结果上报；防环护栏沿用：每个顶层分组每次运行最多进入 3 次，第 4 次以 `FLOW_LOOP_LIMIT` 失败终止（即使 stopOnFailure 关闭）。

#### Scenario: 循环上限
- **WHEN** 分支组合使同一分组第 4 次进入
- **THEN** 运行以 FLOW_LOOP_LIMIT 失败终止

#### Scenario: 分支跳过上报
- **WHEN** 条件跳转到后置目标步骤
- **THEN** 被跳过区间的步骤在报告中为 skip 状态

#### Scenario: 缺省分支顺序继续
- **WHEN** 组内条件判定为 false 且 false 分支未指定目标
- **THEN** 执行继续该条件的下一步骤（如组内容忍式登录步骤），运行不终止

#### Scenario: 慢页面判定容忍
- **WHEN** 网关条件在导航后立刻求值而目标元素尚未渲染
- **THEN** 求值在窗口内重试，元素出现后判定为真，不因瞬时缺失误判为 false

#### Scenario: 任意步骤目标
- **WHEN** 条件步骤的目标指向另一组内的某个具体步骤（非该组开头）
- **THEN** 游标跳到该步骤继续执行，目标之前的该组步骤上报 skip

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

### Requirement: Manual-execution steps SHALL pause replay for user confirmation

`execution: "manual"` 的步骤 SHALL 不由引擎代执行：回放到该步骤时暂停，经宿主确认回调（复用 userOperation 通道）等待用户完成该步骤后继续，提示语用步骤 label；宿主未提供确认回调的环境以 `NOT_ACTIONABLE` 失败。录制与手动添加的动作步骤默认 `manual`（导航、等待等非动作类型除外），Refine 由 AI 按业务逐步判定，用户可在 Instruction 技术抽屉手动改执行方式；省略字段 = `automated`（历史 Flow 的隐式默认）。

#### Scenario: 人工步骤暂停
- **WHEN** 回放进行到一个 execution 为 manual 的步骤
- **THEN** 回放暂停并显示该步骤的提示，用户确认完成后继续下一步

#### Scenario: 录制默认人工
- **WHEN** 停止一次新录制并查看动作步骤
- **THEN** 动作步骤的执行方式默认为 manual，用户可改回 automated

### Requirement: Replay SHALL gate on Reference validation and resolve values before startup

回放启动前 SHALL 对全部 Reference 对象统一执行一次校验与求值，并一次性报告全部违规（对象 label + 规则 + 原因），存在任何违规则不启动回放。校验范围：必填缺失（含条件必填表达式为真时的缺失）、格式预设与自定义正则、正负规则、公式与条件表达式的求值错误。求值与注入语义：公式对象的值由表达式求值产生；大小写规则在注入前应用；非必填且无值、无默认、无公式的对象以空串注入（替代旧的缺失即失败语义）；密钥对象沿用只进当次回放、不落盘的既有行为。

#### Scenario: 必填缺失阻止启动
- **WHEN** 用户在两个必填对象留空时点击回放
- **THEN** 启动被阻止，一次性列出两个对象的必填违规，回放不开始

#### Scenario: 非必填空串继续
- **WHEN** 某非必填对象无值无默认无公式
- **THEN** 回放正常启动，该对象以空串注入模板，不再因缺失失败

#### Scenario: 公式回放期求值
- **WHEN** 某日期对象公式为 `DATEADD(TODAY(), 7, "day")`
- **THEN** 每次回放启动时重新求值，注入的值为当天加 7 天
