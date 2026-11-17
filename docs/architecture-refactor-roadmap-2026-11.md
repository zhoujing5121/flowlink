# FlowLink 下一阶段架构重构提案：Workflow IR、Process Studio 与语音交互

> 文档类型：架构评估与实施路线图  
> 基线：GitHub `master`，2026-11-17（本次检查时的仓库版本）  
> 适用范围：FlowLink Electron 桌面端、Recorder、Schema/IR、Resolver、Executor、Pi Agent、Process UI  
> 状态：提案，尚未实施。本文不代表下述能力已经存在。

---

## 0. 执行摘要

FlowLink 已经从简单的浏览器宏录制器发展为具备多标签页采集、结构化动作 IR、元素证据、自愈回放、AI 细化和 AI 接管能力的桌面工作流工具。下一阶段建议把核心抽象从「一组按顺序执行的步骤」提升为「可理解、可编辑、可验证、可恢复的工作流」。

建议围绕三项产品能力进行重构：

1. **Schema / Workflow IR：** 在保留录制证据和旧 Flow 兼容性的基础上，逐步补足显式循环、人工任务、重试策略、数据迭代、系统/标签页上下文、执行状态与来源追踪。区分不可变的 Capture Evidence、可编辑的 Workflow Definition 和每次运行的 Run State。
2. **Process Tab：** 从当前以 group 为编辑单位、以图形展示为主的页面，升级为 Workflow Studio。图形画布负责理解控制流；阶段/步骤检查器负责编辑；运行面板负责观察执行；证据面板负责查看原始录制、定位和 AI 修改依据。用户不应再通过改一段目标文本来修改定位器。
3. **语音交互：** 把语音作为 FlowLink 的统一交互输入/输出通道，而不是把语音识别直接塞进 Recorder 或把每句话转换成浏览器 click。优先支持 Push-to-talk、语音命令、口述备注/步骤描述、变量填充、AI 建议朗读和人工确认；所有会改变工作流或执行浏览器操作的语音意图都必须经过权限与确认策略。

**关键架构判断：** 不建议立即把现有 `steps[]` 全部替换为自由图节点，也不建议一次性引入通用 BPMN。应先演进现有 Flow v2，采用渐进式 Flow v3：增加显式循环、人工任务、步骤策略、丰富的变量/数据集、统一 provenance 和运行时事件；在一段时间内继续支持现有 group/condition 模型。图形连接关系优先由经过校验的控制流语义派生，避免同时维护两套互相矛盾的流程真相。

---

## 1. 当前架构基线

### 1.1 现有运行时分层

当前主要链路：

```text
Renderer (index.html / app.js / bridge.js)
       │ window.flowlink (preload)
       ▼
Electron main (src/main.ts)
       ├── WebContentsView tabs / browser lifecycle
       ├── TaskStore (tasks.json)
       ├── EngineBridge (CDP ↔ Playwright Page)
       ├── Recorder session
       ├── Flow load/save + Executor session
       └── Pi worker / AI takeover
              │
              ▼
       Engine packages
       ├── schema     Flow Zod contract / migration / IO
       ├── recorder   DOM capture / raw events / coalescing / planning
       ├── resolver   candidates / fingerprint / frame resolution
       └── executor   sequencing / actions / assertions / artifacts
```

当前职责边界是合理的，尤其以下约束应作为重构的硬性架构原则：

- Renderer 只能通过 preload 暴露的 `window.flowlink` 能力访问主进程；不引入 Node/Electron API。
- Main process 拥有 Electron BrowserWindow、WebContentsView、IPC 和浏览器生命周期。
- Recorder 负责采集事件与事实；Resolver 负责定位；Executor 负责执行语义。
- 所有 Flow 写入都必须通过 Zod parse + contract validation。
- 密码只能使用变量模板，不允许进入普通日志、AI prompt 或录制证据明文。
- `observed` 是录制时事实，不允许回放、自愈或 AI 修改；`candidates`、`fingerprint` 是可版本化的解析数据。
- 大型截图、视频、DOM 快照留在 artifacts，Flow IR 只引用受校验的相对路径。
- Pi worker 负责模型会话和建议，不应直接拥有持久化 Flow 或浏览器控制权。

### 1.2 当前 Schema 的能力和边界

当前唯一权威定义位于 `engine/schema/src/schema.ts`，版本为 **v2**。主要结构包括：

- Flow 元数据：id、title、version、createdAt、environment、recorder。
- variables：string/text/email/date/number/secret/file，支持 input/csv 来源。
- Step discriminated union：navigate、click、input、select、key、hover、scroll、drag、upload、wait、assert、condition、extract、script、dialog、switchTab、openTab、closeTab，以及递归 group。
- ElementRef：observed、candidates、fingerprint、frame、description、nearbyText、crop。
- Step 通用属性：label、execution（automated/manual）、timeout、isOptional、expect、page、tab/system provenance、sourceEventIds、locatorEvidence、reviewRequired、settle。
- v0/v1 通过 `migrateFlow()` 迁移到 v2；`parseFlow()` 统一迁移、Zod 解析和跨字段契约检查。

当前控制流主要依赖顶层 group 和 group 末尾的 condition：

- condition 必须是顶层 group 的最后一步。
- true/falseGroupId 指向已存在的非空顶层 group。
- Executor 使用扁平游标执行，支持跳转；每个 group 有最多三次访问的循环护栏。
- 没有显式的数据迭代/循环类型；回边 condition 只是有限重试的替代物。
- Process graph 能显示 condition 分支，但 AI takeover 当前按剩余步骤线性投影，不能完整遵循分支语义。

这意味着当前 Schema 对「录制并重放线性业务流程」已经足够成熟，但对「复杂业务编排」还缺少一等语义：循环、重试、人工任务、数据集迭代、异常路径、可恢复运行状态、可审计的 AI 变更。

### 1.3 当前 Process Tab 的真实产品形态

当前 Process 是以 group 为编辑单元的流程图：

- group 表示阶段，group 内含有序 steps。
- graph 展示 fall-through、condition 分支和回边。
- 用户可以新增/编辑步骤、拆分/合并/移动 group。
- 编辑经过 `flow:updateSteps` 和 schema validation 持久化。
- AI 合并的来源链可用 sourceFlowId/sourceFlows 表达。
- 回放时可以在同一图上叠加步骤状态和走过的边。

这是正确的演进起点，不应推翻。主要问题是：当前图形、步骤字段、运行控制、证据查看和 AI 修复还没有形成一个统一的编辑/运行工作台；部分旧 Instruction 路径曾经存在本地草稿与 Flow 持久化不一致的问题，因此后续所有编辑都必须只有一个持久化入口。

### 1.4 当前录制与证据结构的价值

FlowLink + FlowForge 的合并已经提供了很好的三层基础：

1. FlowLink executable Flow JSON：回放的权威输入。
2. `flowforge-recording.json`：原始事件、tab/system、事件顺序、DOM signature、定位证据和 semantic projection。
3. artifacts：截图、视频、步骤截图、执行结果和日志。

不要把 FlowForge sidecar 变成第二份可执行 Workflow Schema。它应该继续承担证据档案的职责；Flow IR 承担执行定义；Run Artifact 承担某一次运行的事实。

---

## 2. 目标架构：从 Recorder 到 Workflow Studio

### 2.1 推荐的目标分层

```text
┌───────────────────────────────────────────────────────────┐
│                    Workflow Studio UI                     │
│ Process Canvas | Inspector | Evidence | Run Monitor | Voice│
└────────────────────────────┬──────────────────────────────┘
                             │ typed preload API
┌────────────────────────────▼──────────────────────────────┐
│                    Electron Application                   │
│ Main / IPC / Browser Tabs / Permission & Session Manager  │
│ Task & Workflow Repository / Run Coordinator              │
│ Voice Gateway / AI Proposal Coordinator                   │
└──────────────┬────────────────┬────────────────┬───────────┘
               │                │                │
       ┌───────▼──────┐ ┌───────▼──────┐ ┌───────▼────────┐
       │ Workflow IR │ │ Evidence     │ │ Run Runtime    │
       │ Schema/IO   │ │ Archive      │ │ State/Events   │
       │ Migration   │ │ Recorder     │ │ Executor       │
       └───────┬──────┘ └──────────────┘ └───────┬────────┘
               │                                 │
       ┌───────▼─────────────────────────────────▼────────┐
       │ Resolver / Browser Adapter / Tab-System Registry │
       └──────────────────────────────────────────────────┘
                             │
                    Pi Agent / Voice Providers
             (proposal and interpretation, not authority)
```

建议新增或明确四个服务边界：

| 服务 | 职责 | 不应承担 |
|---|---|---|
| WorkflowRepository | Flow 读取、迁移、校验、版本化保存、变更记录 | 执行浏览器动作 |
| RunCoordinator | 创建 Run、调度 Executor、暂停/恢复/取消、状态事件 | 修改 Workflow Definition |
| EvidenceRepository | 保存 raw events、截图、DOM snapshot、agent evidence，并建立来源关联 | 直接改变执行语义 |
| InteractionGateway | 语音/文本/快捷键统一意图入口、权限检查、确认与路由 | 绕过 Executor 直接执行任意脚本 |

这四个边界不要求一开始就拆成独立进程或 npm package。第一阶段可在现有 main/engine 模块内建立接口和目录边界，待测试覆盖和生命周期稳定后再决定是否拆包。

### 2.2 三种数据必须分开

| 数据对象 | 代表什么 | 是否可变 | 示例 |
|---|---|---|---|
| Capture Evidence | 用户当时真实做了什么、页面提供了什么事实 | append-only；纠错通过新事件/注释表达 | raw event、observed、DOM signature、截图 |
| Workflow Definition | 用户希望系统以后如何完成任务 | 可编辑、版本化、可审计 | group、step、branch、loop、变量、策略 |
| Run State / Run Evidence | 某次运行实际走了哪条路径、执行结果如何 | 运行期间更新；结束后不可变归档 | 当前节点、变量快照引用、重试、agent action、结果 |

这三者不应合并到一个不断被覆盖的 JSON 中。尤其：

- AI Refine/Repair 产生的是新的 Workflow Definition 版本或 proposal，不得改写原始 Capture Evidence。
- 每次执行创建独立 Run ID；暂停/恢复只改变 Run State，不改源 Flow。
- AI takeover 的实际浏览器操作必须形成 Run Evidence；只有经过验证、用户接受后，才能作为新 Workflow Definition 的修改提案。
- 对 secret 只保存变量引用和受控凭据引用；Run log 记录“使用了 secret variable X”，不记录值。

---

## 3. Schema 重构建议

### 3.1 版本策略：采用渐进式 v3，而不是一次性重写

建议新增 **Flow Schema v3**，但按兼容性分阶段落地：

1. v3 第一阶段只新增可选字段和新 Step kind，旧 Flow 的结构和执行结果保持不变。
2. v2 -> v3 migration 只补默认值、规范化字段，不猜测用户意图，不自动把普通 group 转成复杂控制节点。
3. 旧 condition 的 trueGroupId/falseGroupId 在 v3 初期继续可用；内部可由统一 ControlFlow adapter 解释。不要同时维护两个可独立编辑的分支来源。
4. 当 v3 编辑器、执行器、AI takeover 和迁移测试都稳定后，再考虑将控制流关系提升为独立 transitions 数组。该动作应是另一个明确版本升级，不应夹带在第一轮。
5. 未知未来 schemaVersion 必须拒绝加载并给出升级提示，禁止静默降级。

建议在 Schema 包中明确导出：
- `FlowV3Schema` / `FlowSchema`
- `migrateFlow()`
- `parseFlow()`
- `validateFlowContract()`
- `serializeFlow()`
- `getWorkflowCapabilities()`（供 UI/Agent 识别当前 Flow 能力）
- `toLegacyFlowProjection()`（只在兼容边界使用）

### 3.2 v3 的建议顶层结构

下面是概念示意，不是要求逐字照搬的最终 TypeScript：

```ts
type FlowV3 = {
  schemaVersion: 3
  id: string
  title: string
  version: number
  createdAt: string
  updatedAt?: string

  meta: {
    env: Env
    recorder: RecorderInfo
    sourceFlows?: SourceFlow[]
    tags?: string[]
    systems?: SystemDescriptor[]
  }

  variables: VariableV3[]
  datasets?: DatasetDefinition[]
  steps: StepV3[]                 // 继续保留现有 group 容器
  settings?: WorkflowSettings
  extensions?: Record<string, JsonValue>
}
```

关键点：

- 保留 `steps[]` 和 group 作为兼容容器，避免第一轮就要求所有 UI/Executor 改成全新 graph engine。
- 新增 `settings`、`datasets` 和更清晰的 `meta.systems`，把工作流级配置从单个 step 中抽离。
- 对扩展字段采用受控 namespace 和 schema 校验；不要无边界地开放任意 JSON 让 AI 写入。
- `version` 是用户可见的 Workflow 版本；`schemaVersion` 是数据格式版本，两者不能混用。

### 3.3 Step 类型：按语义分层，而不是无序堆积 kind

建议把 Step 分成四类，UI 和 Agent 都按类别理解：

**A. Browser Action（浏览器动作）**

保留现有 navigate/click/input/select/key/hover/scroll/drag/upload/dialog/openTab/switchTab/closeTab/extract/script。逐步补足：

- 统一 `target` 仍然使用 ElementRef，不把 selector 字符串作为唯一定位信息。
- `pageContext` 或现有 page/tabId/systemId 逐步规范化为可验证的 BrowserContextRef。
- `input` 增加安全的 value binding/transform 引用，但不得在普通 Flow 或 log 中保存 secret 明文。
- `upload` 应使用受控 file variable / user-selected file handle，不应在 AI 可编辑文本中接受任意本地绝对路径。
- `script` 需要独立的 capability/policy（允许域、执行环境、超时、审计）；建议默认标记为 advanced/unsafe，并禁止语音直接创建或修改。

**B. Control Flow（控制流）**

- `condition`：保留当前语义，逐步补充可读的表达式/断言摘要、分支目标存在性、分支可达性检查。
- 新增 `loop`：显式有界循环。第一版只支持 `count` 和 `while` 两种模式；每个 loop 必须有 maxIterations，运行时再受全局预算约束。
- 新增 `forEach`：对 Dataset/数组变量迭代，显式定义 source、itemVariable、indexVariable、bodyGroupId、maxItems。
- 新增 `break` / `continue` 之前先评估是否可用 loop body 子图自然表达；不要过早加入不必要的跳转语义。
- 不建议第一版引入任意表达式语言。条件表达式优先使用有限的 discriminated union（visible、hidden、text、value、count、url、variable 等），防止执行器和 AI 对表达式含义各自解释。

概念结构：

```ts
type LoopStep = BaseStep & {
  kind: 'loop'
  mode: 'count' | 'while'
  bodyGroupId: string
  maxIterations: number
  count?: number
  condition?: ConditionExpression
  iterationVariable?: string
}

type ForEachStep = BaseStep & {
  kind: 'forEach'
  source: { kind: 'dataset' | 'variable'; ref: string }
  bodyGroupId: string
  itemVariable: string
  indexVariable?: string
  maxItems: number
}
```

Loop 必须有硬上限；不允许无限循环。循环迭代数、总运行时长、最大步骤数、最大模型调用数均由 RunPolicy 约束。

**C. Human Interaction（人工介入）**

当前 `execution: 'manual'` 和 `wait/userOperation` 已有雏形，但语义不够明确。建议新增一等 `humanTask`：

- `prompt`：要用户完成什么。
- `expectedOutcome`：用户完成后系统验证什么（可选）。
- `resumePolicy`：确认继续、验证后继续、取消运行。
- `inputSchema`：用户需要填写哪些结构化数据（不保存敏感值到日志）。
- `timeout` / `onTimeout`：超时策略。
- `evidenceRequired`：是否要求用户提供截图/备注/确认。

典型场景：验证码、企业 SSO、多因素认证、桌面外系统、审批确认、无法自动化的业务决策。人工步骤应成为图上的明显节点，而不是隐藏在普通 wait 中。

**D. Data / Annotation（数据和注释）**

- `extract`：保留，并为输出变量声明类型和敏感级别。
- `note` / `checkpoint`：可考虑新增轻量注释/检查点，不应被误当成浏览器动作。
- AI 生成的说明、风险提示和建议变更应进入 proposal/audit 结构，不直接成为可执行 step。

### 3.4 BaseStep 的建议增强

建议逐步增加以下可选字段：

| 字段 | 用途 | 约束 |
|---|---|---|
| `description` | 解释为什么要执行这一步 | 不代替 label |
| `retryPolicy` | 次数、间隔、可重试错误类别 | 总重试次数受 RunPolicy 限制 |
| `failurePolicy` | fail / skip / askHuman / routeToGroup | 默认 fail，不能让 AI 静默决定 skip |
| `preconditions[]` | 执行前状态条件 | 使用有限表达式 schema |
| `postconditions[]` | 执行后结果验证 | 复用 Expect/Assertion 体系 |
| `evidencePolicy` | 是否保存截图、DOM 摘要、命中定位证据 | 支持隐私等级 |
| `tags[]` | 搜索、过滤和 UI 分组 | 不作为执行逻辑 |
| `provenance` | 来源事件、来源 Flow、AI proposal id、人工编辑记录 | append-only audit 关联 |
| `riskLevel` | 普通/敏感/不可自动执行 | 执行前做 capability check |

不要把这些字段全部放进所有 step 的必填字段。Zod default 和 migration 应确保旧 Flow 不因新字段而改变行为。

### 3.5 ElementRef 与定位证据：保持现有核心不变

这是 FlowLink 的技术差异化能力，不建议重写：

- `observed` 永远保留录制时事实。
- `candidates` 可以在 self-heal/repair 中生成新版本，但每次变更要记录旧值、新值、来源和置信度。
- `fingerprint` 的版本变更必须与 repair event 关联。
- `crop.ref`、DOM snapshot、a11y snapshot 继续放在 artifacts/evidence，不塞入 Flow。
- UI 目标字段应成为证据查看器，而不是自由文本 selector 编辑框。
- AI 可以建议 candidate 更新，但必须经过 resolver 校验（唯一性、可见性、frame、system/tab 上下文）和用户/策略批准。
- 无法可靠解析的目标应标记 reviewRequired，并提供重录或从元素库重新绑定路径。

### 3.6 Variables 与 Dataset：从简单变量升级为数据契约

当前 Variable 已支持基础类型和 input/csv。建议 v3：

```ts
type VariableV3 = {
  name: string
  type: 'string' | 'text' | 'email' | 'date' | 'number' |
        'boolean' | 'secret' | 'file' | 'object' | 'array'
  required?: boolean
  secret?: boolean
  source: 'input' | 'csv' | 'dataset' | 'extracted' | 'system'
  defaultValue?: JsonValue
  description?: string
  validation?: { pattern?: string; min?: number; max?: number }
}
```

另增 DatasetDefinition：
- id/name/schema/rowCount/source。
- 来源可以是用户导入 CSV、手动数据表、运行时提取结果。
- CSV 行数据不应直接复制进 Workflow Definition；Flow 保存 dataset 引用和字段 schema，实际数据存储在独立数据文件或用户选择的受控位置。
- 每次 batch run 对每行创建独立 Run Context，避免变量和浏览器状态串行污染。
- secret 字段不允许导出到普通 CSV、日志、AI context 或运行结果摘要。

### 3.7 RunPolicy 与运行状态 Schema

把运行策略从散落在 Executor 常量中逐步抽出：

```ts
type RunPolicy = {
  maxDurationMs: number
  maxSteps: number
  maxLoopIterations: number
  maxRetriesPerStep: number
  maxAgentActions: number
  allowedDomains: string[]
  allowNewTabs: boolean
  allowFileUpload: boolean
  requireHumanApprovalFor: string[]
}
```

每次运行单独创建 RunRecord（不写回 Flow）：

- runId、flowId、flowVersion、startedAt、endedAt。
- status：queued/running/paused/waitingHuman/failed/succeeded/cancelled。
- currentGroupId/currentStepId、branch decisions、loop counters。
- variable snapshot reference（secret 值只存安全引用或加密存储）。
- step events、retry events、human approvals、AI takeover events。
- artifact references、error summary、final outcome。

Run 状态要支持进程异常退出后的安全恢复。第一版可先实现“恢复为可查看的中断状态”，之后再做真正 resume；不能在没有验证浏览器状态的情况下盲目续跑。

### 3.8 Schema 跨字段校验清单

v3 必须在 `validateFlowContract()` 增加：

- 所有 step/group/dataset/variable id 唯一。
- 所有 group 引用目标存在且非空。
- loop body 存在、不能自引用非法结构，maxIterations/maxItems 必须有限且在上限内。
- condition/loop 的控制流不能跳到非法嵌套层级。
- 不允许不可达 group，或至少产生明确 warning。
- 检测无退出路径的循环；所有 loop 必须有预算上限。
- 变量引用存在、类型匹配、secret 使用符合安全规则。
- ElementRef crop/artifact 路径保持相对路径安全。
- manual/humanTask 不得被自动执行器当作普通动作跳过。
- script/upload 等高风险步骤要求相应 capability。
- 不允许 AI 在 proposal 中新增不受支持的 kind 或未知扩展字段。

---

## 4. Process Tab：升级为 Workflow Studio

### 4.1 设计目标

Process Tab 不应只是“把步骤画成图”。它应回答用户五个问题：

1. 这个流程由哪些业务阶段组成？
2. 每个阶段具体做什么，为什么这么做？
3. 条件、循环、跨系统和人工介入时会走哪条路径？
4. 上一次运行实际执行了什么，在哪一步失败，证据是什么？
5. 我修改的内容会影响什么，如何验证并发布为新版本？

### 4.2 推荐信息架构

建议采用四个常驻区域，允许用户折叠：

```text
┌──────────────────────────────────────────────────────────────┐
│ Process toolbar: Flow version | Validate | Run | Refine | ...│
├───────────────┬──────────────────────────────┬───────────────┤
│ Outline       │ Workflow Canvas             │ Inspector     │
│               │                              │               │
│ Stage tree    │ Groups / Branch / Loop      │ Properties    │
│ Search        │ System & tab lanes          │ Step fields   │
│ Issues        │ Run overlay                 │ Policy        │
│               │                              │               │
├───────────────┴──────────────────────────────┴───────────────┤
│ Evidence / Run Timeline / AI Proposal / Voice transcript     │
└──────────────────────────────────────────────────────────────┘
```

**A. Outline（左侧）**
- 按业务阶段显示 group.label，而不是只按 tab/url 分组。
- 支持搜索步骤、筛选系统、只看失败/待审核/人工步骤。
- 显示每组 step 数量、风险、验证状态。
- 拖动排序只允许在语义合法的范围内进行；跨组移动前要检查 condition/loop 引用。

**B. Canvas（中间）**
- group 是业务阶段容器；动作是容器内部的有序步骤。
- condition 显示 true/false 分支；loop 显示循环体、次数上限和退出条件。
- humanTask 显示暂停/人工确认节点。
- system/tab 以泳道或轻量标签展示，避免把每个浏览器 tab 画成独立业务阶段。
- 支持三种视图：Business（默认，业务语言）、Execution（技术动作/控制流）、Run（某次运行的实际路径）。
- Run overlay 需要区分：已执行、当前、跳过、重试、失败、AI 执行、人工完成、未走分支。
- 图布局使用 Dagre 等现有能力即可；第一阶段不必引入复杂 BPMN 编辑器。

**C. Inspector（右侧属性检查器）**
按选中对象动态显示属性：
- Flow：名称、描述、版本、环境、全局策略、系统列表。
- Group：业务目标、输入/输出、系统、前置/后置条件、超时、失败策略。
- Step：label、description、kind-specific 字段、timeout、retry、optional、settle、expect、execution mode。
- Condition：断言、true/false 目标、无匹配时的策略。
- Loop/ForEach：数据源、迭代变量、上限、退出条件。
- HumanTask：提示、期望结果、确认/验证方式。
- Element target：只读证据查看器，展示 crop、observed 摘要、候选列表、fingerprint、frame 路径和最近 repair 历史。

**D. Bottom panel（底部运行/证据面板）**
- Run Timeline：逐步事件、耗时、状态、错误。
- Evidence：录制事件、截图、DOM signature、定位器命中信息。
- AI Proposal：显示 AI 建议的结构化 diff，逐项接受/拒绝。
- Voice：显示本次语音转写、识别意图、执行动作与确认记录。
- 默认收起，发生失败/人工等待/AI 建议时可自动展开。

### 4.3 编辑体验：自然语言和结构字段双层呈现

保留“每步一句人话”的主体验：

- 行标题优先使用 `step.label`；没有 label 时才从 kind/target/value 生成 fallback。
- 用户可直接编辑 label；label 只改变说明，不改变执行动作。
- 高级用户展开 Inspector 编辑结构化字段。
- 不要允许用户通过普通文本框改 selector。目标只能从录制证据、元素库或重录步骤中选择。
- AI 润色 label 必须限定为 label-only proposal，不能暗中修改 step kind 或 target。
- 任何结构性编辑都通过同一条 `WorkflowRepository.update` / preload API 保存，成功后以服务端返回的已校验 Flow 更新 UI；失败则保留草稿并显示校验问题。
- 删除/移动/拆组等操作应生成可撤销的变更记录，至少支持本地 undo。

### 4.4 Process 编辑模型：不要把 Canvas state 当成 Flow

Renderer 应把以下状态分开：

- `persistedFlow`：最近一次从主进程加载/保存成功的已校验 Flow。
- `draftOperations`：用户尚未保存的编辑操作（可选，若坚持即时保存则只保留短暂 pending state）。
- `selectedEntity`：选中的 group/step/edge。
- `canvasLayout`：节点位置、缩放、折叠等纯 UI 状态，不进入执行 Flow。
- `runOverlay`：当前/历史 Run 状态，永远不写进 Flow。
- `proposalDiff`：AI 生成的候选变更，未接受前不影响 persistedFlow。

所有变更采用命令形式，例如：
- RenameGroup
- MoveStep
- AddStep
- UpdateStepProperties
- AddConditionBranch
- AddLoop
- BindElementEvidence
- AcceptProposal

命令在主进程执行 schema 校验、契约校验和版本冲突检查。返回新 Flow、validation issues 和新的版本号。避免多个 renderer helper 各自直接 mutate `item.processFlow` 后再猜测何时持久化。

### 4.5 从录制到 Process 的体验

停止录制后，不要只给一条“生成了 N 个步骤”的消息。建议进入 Review 阶段：

1. Recorder 自动整理 raw events -> semantic steps -> groups。
2. Process 显示按业务阶段组织的初稿。
3. 系统标出低置信度定位、未分类系统、无法配对的拖拽、未知导航、敏感字段和潜在人工步骤。
4. AI 可以提出 group label、步骤 label、阶段边界和缺失断言建议。
5. 用户接受后生成新的 Workflow Definition 版本；原始录制和 evidence archive 不变。
6. 自动执行 schema validation 和静态流程检查；用户可立即 Test。

---

## 5. 语音功能：统一 Interaction Gateway

### 5.1 产品定位

语音不是“让 AI 听到用户说话后随意点击网页”。它是 FlowLink 的一种交互方式，应该和键盘、鼠标、文本 AI pane 一样走统一的命令与权限系统。

建议先支持以下场景：

| 场景 | 例子 | 是否需要确认 |
|---|---|---|
| 应用控制 | “开始录制”“暂停回放”“停止当前任务” | 低风险动作可直接执行，但需清晰反馈 |
| 录制备注 | “这里需要财务经理审批” | 不需要，作为注释保存前预览 |
| 步骤描述 | “把这一步标记为提交采购申请” | 保存前展示 label 变更 |
| 流程查询 | “当前流程有几个阶段？”“为什么这一步失败？” | 不需要 |
| 变量填充 | “客户名称是 Acme” | 根据字段敏感等级确认；secret 不允许语音明文落日志 |
| 流程修改 | “在提交后加一个人工审批步骤” | 必须展示结构化 proposal 并确认 |
| 浏览器操作 | “点击提交按钮” | 必须限定当前 tab、当前目标和动作风险；关键业务动作再次确认 |
| AI 解释/朗读 | “读一下失败原因” | 不需要，可随时打断 |

### 5.2 分层架构

```text
Microphone / Push-to-talk
        │
        ▼
Audio Capture Adapter (renderer or native host)
        │ audio frames / permission / device
        ▼
Speech Provider Adapter
   ├── Local STT (privacy-first option)
   ├── Cloud STT (opt-in provider)
   └── OS speech service
        │ transcript + confidence + timestamps
        ▼
Interaction Gateway
   ├── Intent parser (command schema)
   ├── Context resolver (selected task/flow/tab/step)
   ├── Policy & permission check
   └── Confirmation manager
        │ typed command
        ▼
Workflow Command Bus / AI Proposal / RunCoordinator
        │
        ├── TTS Adapter -> voice playback
        └── Audit Event -> Run/Evidence timeline
```

语音组件不应直接调用任意 IPC，也不应直接调用 Playwright。它只能产生受限的 typed intent，例如：

```ts
type VoiceIntent =
  | { kind: 'app.startRecording' }
  | { kind: 'app.stopRecording' }
  | { kind: 'run.pause' }
  | { kind: 'run.resume' }
  | { kind: 'flow.query'; question: string }
  | { kind: 'step.addNote'; stepId?: string; text: string }
  | { kind: 'step.updateLabel'; stepId: string; label: string }
  | { kind: 'variable.proposeValue'; name: string; value: string }
  | { kind: 'workflow.proposeChange'; instruction: string }
  | { kind: 'browser.proposeAction'; action: string; targetHint?: string }
```

Intent parser 的输出必须经过 Zod 校验、上下文解析和 policy check。模型输出不是权限凭证。

### 5.3 STT/TTS 技术选择建议

不要把整个语音能力绑定到单一供应商。定义接口：

```ts
interface SpeechToTextProvider {
  start(options: { locale: string; interimResults: boolean }): Promise<void>
  pushAudio(frame: AudioFrame): Promise<void>
  stop(): Promise<Transcript>
  cancel(): Promise<void>
}

interface TextToSpeechProvider {
  speak(text: string, options: { voice?: string; rate?: number }): Promise<void>
  stop(): Promise<void>
}
```

建议按优先级推进：

1. **MVP：Push-to-talk + STT adapter + 系统 TTS。** 先验证语音命令与 Process/AI pane 的交互价值。不要一开始就做常驻监听或唤醒词。
2. **本地识别选项：** 评估 Windows 原生语音服务或可离线部署的 STT 引擎。优点是业务数据不必上传；代价是 Windows 版本差异、模型体积、CPU/GPU、语言包和安装包复杂度。
3. **云端识别选项：** 作为用户明确启用的 provider，支持企业代理/网络配置、语言/地区配置和服务状态提示。音频上传必须显式授权。
4. **TTS：** 第一版优先使用操作系统可用语音能力；后续再提供云端高质量语音。TTS 不应阻塞 Executor。
5. **Provider capability：** 启动时检测支持的语言、离线能力、流式识别、置信度和最大音频时长；UI 根据能力显示选项，不假设所有 Windows 机器都一致。

Web Speech API 可以作为原型或 fallback，但不建议把它作为 Windows Electron 产品唯一的生产 STT 实现：不同 Chromium/Electron 版本的识别服务可用性、离线能力和权限行为并不稳定。

### 5.4 音频与权限安全

- 默认关闭麦克风；用户按下 Push-to-talk 后才开始采集。
- 第一版不做 always-on microphone、不做 wake word。
- 麦克风权限和系统音频设备权限要有明确 UI 状态。
- 原始音频默认只在内存中流转，不写入 Flow、Run log 或 Evidence Archive。
- 若用户显式选择保存音频用于审计，必须独立开关、说明保留期限和存储位置。
- 转写文本在写入流程前做敏感字段检查；password、token、cookie、银行/个人敏感字段不能进入普通 transcript history。
- 对语音输入的 secret，优先提示用户使用安全输入控件，不建议通过语音说出口令。
- 语音命令执行危险操作（删除录制、覆盖版本、上传文件、提交业务表单、运行脚本）必须确认。
- AI 语音建议只能形成 Proposal；“听起来像确认”不能替代 UI 的显式确认。
- 语音活动、转写文本、意图和最终命令都应有可审计事件，但默认不记录音频。

### 5.5 语音与 Recorder/Browser 的关系

语音不应伪装成用户在网页上点击/输入的录制事件。需要区分：

- `source: 'human-pointer'`
- `source: 'human-keyboard'`
- `source: 'voice-command'`
- `source: 'ai-agent'`
- `source: 'executor'`

这些 provenance 应记录在 Run Event 或 Interaction Event 中。若语音命令触发浏览器动作，真正的执行仍走 Executor/Browser Adapter；Recorder 可以记录最终浏览器实际发生的事实，但要通过 source correlation id 关联触发命令。这样才能解释“用户说了什么、系统理解了什么、最终做了什么”。

### 5.6 语音 UI 建议

- 全局麦克风按钮放在 AI/命令输入区域，不放在网页内容上。
- 按住说话或点击开始/结束；显示录音状态、实时转写和取消按钮。
- 识别完成后先显示理解结果；只读查询可直接回答，结构修改展示 diff，浏览器操作显示目标与动作。
- 支持“撤销刚才的 label/备注修改”；不能提供对外部业务提交的虚假撤销承诺。
- TTS 朗读可暂停/打断，默认不自动朗读长流程或敏感变量。

---

## 6. AI Agent 与 Workflow Runtime 的职责重划

Pi 应继续作为智能层，而不是执行系统的唯一控制器。

### 6.1 推荐三种 Agent 模式

1. **Advisor：** 解释流程、失败原因、录制质量、潜在风险。只读。
2. **Author：** 生成 Flow/Step/Group/Loop/HumanTask 的结构化 Proposal。不能直接保存。
3. **Takeover：** 在某个 Run 中临时操作浏览器，完成当前运行的剩余目标。只能写 Run Evidence，不能写源 Flow。

### 6.2 Proposal 必须是结构化 diff

Proposal 应包含：
- proposalId、baseFlowId、baseVersion。
- change operations（add/update/remove/move）。
- 每项修改的 reason、source evidence、confidence、risk。
- validation result 和 preview。
- accepted/rejected/revised 状态及操作者、时间。

接受 Proposal 时必须检查 baseVersion；如果用户已经修改 Flow，旧 Proposal 不能直接覆盖新版本。合并冲突必须重新生成或人工解决。

### 6.3 AI Takeover 的正确闭环

建议运行闭环：

1. Executor 在确定的 step/group 失败，RunCoordinator 暂停 Run。
2. 用户点击 AI Continue 或通过语音提出“尝试继续”；系统展示失败点、剩余路径和所需 secret/权限。
3. ControlFlow adapter 先求值 condition，并按当前 Run State 确定合法后续路径。
4. Agent 在允许域、允许 tab、允许动作和预算范围内操作浏览器。
5. 每个 agent action 产生 Run Evidence：时间、tab/system、动作、命中元素证据、前后状态、结果。
6. Agent 声明完成后，由 Executor/验证器检查 postcondition，而不是只相信模型的 done=true。
7. 若完成，Run 可以继续或标记 AI-assisted success；源 Flow 不变。
8. 可选生成 Repair Proposal，利用 agent 实际命中的证据提出 candidate/fingerprint 更新。
9. 用户审阅并接受后，生成新 Flow 版本，再进行独立 Test。
10. 只有测试通过，用户才将新版本设为当前可用版本。

不要承诺 AI “一定能完成”。正确产品承诺是：系统会在明确预算和权限边界内尽可能恢复；失败时给出可审计的原因和下一步，而不是无限尝试。

---

## 7. 文件/模块演进建议

建议先建立职责，不急于物理拆包：

| 现有位置 | 建议演进 |
|---|---|
| `engine/schema/src/schema.ts` | 按 flow/step/variable/run-policy 子模块拆分 schema，再从 index 汇总导出 |
| `engine/schema/src/io.ts` | 集中 migration、parse、contract validation、atomic write |
| `engine/recorder/src/` | 保留 raw capture/coalesce/plan；补 source correlation 和 evidence archive version |
| `engine/resolver/src/` | 继续拥有定位算法；增加 repair candidate validation API |
| `engine/executor/src/run.ts` | 将控制流解释抽为 ControlFlow adapter；Run 状态由 RunCoordinator 管理 |
| `src/main.ts` | 逐步拆出 BrowserSessionManager、RecordingCoordinator、RunCoordinator、InteractionGateway |
| `src/store.ts` | Task metadata 继续保留；新增 WorkflowRepository/RunRepository，不把大型 Flow/Run JSON 塞进 tasks.json |
| `src/preload.ts` | 只暴露明确的 typed commands/events；增加 voice/interaction/run APIs，不开放任意 IPC |
| `renderer/app.js` | 将 Process 状态、命令处理、属性检查器、运行面板拆成模块；静态结构继续放 index.html templates |
| `renderer/flow-graph.js` | 专注图布局和渲染；不在图模块里实现业务持久化或执行逻辑 |
| `src/ai-takeover.ts` | 成为 RunCoordinator 的 agent adapter；输出 Run Evidence 和 Proposal，不直接改 Flow |
| `config/prompts.json` | 保留 prompt 模板；增加结构化输出 schema 和版本兼容检查 |

---

## 8. 详细实施计划

建议分 8 个阶段推进。每阶段都能独立交付和验收，避免同时改 Schema、Executor、UI、语音导致难以定位回归。

### Phase 0 — 基线固化与架构测试（约 3–5 个工作日）

**目标：** 在重构前确认现有行为，建立可比较的测试基线。

任务：
1. 记录当前 master commit、Node/Electron/Playwright 版本和 Windows 测试环境。
2. 整理 Flow v2 fixture：普通录制、多 tab、condition、REFINED 登录流程、manual step、upload、secret variable、sourceFlows。
3. 建立 schema migration golden tests：v0/v1/v2 输入必须得到预期 v2 输出。
4. 扩展现有 `tests/flow-authoring.test.mjs`，增加录制、分支、tab、变量、ElementRef 不可变等测试。
5. 对 Executor 建立 deterministic browser fixture：成功、失败、超时、跳转、循环上限、人工暂停。
6. 定义一份真实业务流程验收样本，至少跨两个系统/两个 tab。

交付：
- 架构基线文档和测试 fixture。
- 当前行为清单（哪些是已支持、部分支持、未支持）。
- 无功能变更的 CI/本地测试入口。

验收：
- `npm run build`
- `npx tsc --noEmit`
- `npm test`
- 关键 v2 Flow fixture 加载、保存、再次加载后语义不变。

### Phase 1 — Workflow/Run/Evidence 边界抽象（约 1 周）

**目标：** 不改用户体验，先建立三种数据的所有权。

任务：
1. 定义 WorkflowRepository 接口，把 Flow load/update/save 从零散 IPC handler 收敛。
2. 定义 RunRecord/RunEvent 类型，先记录现有 Executor 的 step start/finish/fail/skip。
3. 定义 EvidenceRepository 接口，统一 artifact reference 和 capture sidecar 查询。
4. 定义 RunCoordinator 最小版本，包装当前 Executor start/stop/pause 逻辑。
5. 在 IPC 中使用明确的 command/result 类型；事件包含 runId、flowId、stepId、sequence。
6. TaskStore 只保留任务与录制元数据；不要把 Run event stream 全量写入 tasks.json。

交付：
- 三个 repository 接口。
- Run event timeline 的 JSON fixture。
- 新旧 API 兼容层。

验收：
- 旧 UI 仍可录制、加载、编辑、回放。
- 每次 replay 都有唯一 runId。
- Run 事件顺序稳定，停止/失败时能完整收尾。
- Flow Definition 不包含本次运行状态。

### Phase 2 — Flow v3 additive schema（约 1–2 周）

**目标：** 先增加 schema 能力，不马上启用全部 UI。

任务：
1. 设计 v3 字段并通过 fixture review。
2. 增加 LoopStep、ForEachStep、HumanTaskStep、DatasetDefinition、RunPolicy schema。
3. 扩展 BaseStep 的 retry/failure/evidence/provenance 字段。
4. 编写 v2 -> v3 migration；旧 condition 保持原字段和执行语义。
5. 扩展 validateFlowContract：id 唯一、引用存在、循环上限、变量引用、嵌套约束、风险能力。
6. 增加 parse/serialize round-trip tests 和未知 schemaVersion 拒绝测试。
7. 做 v2/v3 双向能力矩阵；仅在明确可表达时生成 legacy projection，不允许静默丢失 loop/humanTask。

交付：
- Flow v3 schema 与迁移。
- Schema migration 文档。
- v2/v3 compatibility fixtures。

验收：
- 所有历史 v2 fixture 迁移成功且语义不变。
- 非法循环、悬空 group、重复 ID、未定义变量、越权 script 均被拒绝。
- v3 未支持特性不能被保存成看似成功的 v2 Flow。

### Phase 3 — Executor 控制流与人工任务（约 1–2 周）

**目标：** 让运行时真正理解新增 Schema，而不是 UI 先画出不能执行的节点。

任务：
1. 把 condition 分支解析抽成 ControlFlow adapter，复用 Executor 现有 assertion 逻辑。
2. 统一 step/group 状态事件和跳转决策。
3. 实现有限 count loop；验证 maxIterations 和全局运行预算。
4. 实现 forEach 的数据行隔离、item/index variable scope 和 maxItems。
5. 将 manual wait 演进为 HumanTask：暂停、展示提示、收集确认/输入、验证后恢复。
6. 实现 retryPolicy/failurePolicy 的最小子集；默认仍是失败即停止。
7. 对每次 branch/loop/retry/human approval 写 RunEvent。

交付：
- ControlFlow adapter。
- Loop/ForEach/HumanTask 执行器。
- Run timeline 能显示分支和循环。

验收：
- 同一组数据可重复执行并得到确定的迭代次数。
- loop 超限时给出可读错误，不死循环。
- HumanTask 未确认不能继续。
- condition 的 true/false 路径与旧 v2 完全一致。
- pause/stop 不会遗留浏览器监听或悬挂 Promise。

### Phase 4 — Process Studio 第一版（约 2 周）

**目标：** 先改编辑模型和属性面板，再增加高级图节点。

任务：
1. 建立 Process 的单一 persistedFlow 状态源；Canvas layout、Run overlay、Proposal diff 独立。
2. 统一所有 Flow 修改为 command -> main validation -> persisted response。
3. 先交付 group/step Inspector：label、description、timeout、optional、settle、expect、execution。
4. 将 target 改为 Element Evidence Viewer；展示 crop/candidates/fingerprint/frame，不允许直接编辑 selector 文本。
5. 将 condition 的分支目标编辑纳入 Inspector。
6. 实现 loop 和 HumanTask 节点 UI（仅在 Executor 能力通过测试后开放）。
7. 增加左侧 Outline、Canvas 的 Business/Execution/Run 三视图。
8. 加入校验问题列表、未保存提示、撤销最近一次编辑。

交付：
- Workflow Studio UI 第一版。
- 统一的 Process command API。
- Process 操作说明和快捷键。

验收：
- 新建/修改/移动/删除 group 和 step 后重载仍保持一致。
- condition/loop 连接目标可见且可校验。
- 修改 label 不改变执行语义。
- 修改目标必须通过证据重新绑定，不会丢失原 ElementRef。
- Run overlay 不污染 Flow 文件。

### Phase 5 — AI Proposal 与 Takeover 闭环（约 1–2 周）

**目标：** AI 能读懂新的流程语义，并把实际执行证据反馈给用户。

任务：
1. 定义 Proposal JSON schema 和 operation diff。
2. Pi Author 只输出受校验 Proposal；增加 baseVersion、reason、confidence、evidence refs。
3. 用户接受 Proposal 后通过 WorkflowRepository 应用，不允许 Pi 直接写文件。
4. Takeover 使用 ControlFlow adapter 解析 condition/loop 的合法后续路径。
5. 逐步支持 openTab/switchTab/closeTab；每个操作仍受 BrowserSessionManager 权限约束。
6. Agent action 写入 Run Evidence，包括实际命中元素、tab/system、前后状态。
7. Repair Proposal 可以提出 candidates/fingerprint 更新，但 observed 不可变。
8. 增加 AI 完成后的 postcondition 验证和有限轮次的 Test/Repair。
9. secret 缺失、人工步骤、预算触顶和高风险动作都必须有明确的暂停/退出策略。

交付：
- Proposal diff/review。
- 分支感知的 AI takeover。
- AI Run Evidence 和 Repair proposal。

验收：
- AI 不可能覆盖源 Flow 或 observed。
- Proposal 过期（baseVersion 不匹配）会被拒绝。
- Agent 宣称完成但 postcondition 不成立时不能报告成功。
- Agent 使用的 tab、域名和动作可在 Run timeline 审计。

### Phase 6 — 语音 MVP（约 1–2 周）

**目标：** 语音先成为安全的命令入口，不做自由浏览器代理。

任务：
1. 定义 SpeechToTextProvider/TextToSpeechProvider 接口。
2. 做 Push-to-talk UI、麦克风权限状态、设备选择、取消和转写预览。
3. 先实现少量命令：开始/停止录制、暂停/继续 Run、解释当前步骤、添加备注、朗读失败原因。
4. 将转写结果映射到 VoiceIntent Zod union。
5. 增加 InteractionGateway：当前任务/Flow/Tab/Step 上下文解析，危险操作确认。
6. 实现系统 TTS adapter；支持 stop/interrupt。
7. 明确本地 STT 与云端 STT provider 配置，默认不上传音频。
8. transcript 默认仅保留必要的命令摘要；敏感值脱敏。

交付：
- Push-to-talk 语音输入。
- 语音命令和朗读能力。
- 语音隐私/权限说明。

验收：
- 麦克风默认关闭，用户主动触发才采集。
- 未授权时不会启动识别。
- “添加备注”不会生成浏览器 click。
- “修改流程/执行浏览器操作”必须展示确认。
- 原始音频不会默认落盘或进入 Pi prompt。
- 语音识别失败不影响键盘/鼠标流程。

### Phase 7 — 语音驱动 Workflow Authoring 与稳定化（约 1–2 周）

**目标：** 语音能够自然地参与流程编辑，但仍由 Proposal/Inspector 控制。

任务：
1. 支持“把这一步描述改成…”的 label-only 提案。
2. 支持“在提交后增加人工审批”生成 HumanTask proposal。
3. 支持“解释为什么走了否分支”等 Run State 查询。
4. 支持通过语音导航到某个 group/step，但不直接修改结构。
5. 增加中英文识别、术语词典（系统名称、字段名、业务缩写）和置信度提示。
6. 建立真实噪声环境、耳机/内置麦克风、企业代理和离线模式测试矩阵。

交付：
- 语音辅助 Process 编辑。
- 语音命令审计与撤销能力。
- STT provider 兼容性测试。

验收：
- 低置信度意图只显示转写，不执行。
- 语音 proposal 与鼠标编辑使用同一套 schema validation。
- 中英文混合业务术语可通过用户词典修正。
- 语音服务不可用时，应用其他功能不受影响。

### Phase 8 — 发布、迁移和产品化（约 1 周）

任务：
1. 在真实 Windows 机器上验证 v2 数据迁移、v3 保存和回滚。
2. 验证 Electron 打包、麦克风权限、音频设备、系统 TTS、代理配置。
3. 为 schema、voice provider、Run state 增加诊断信息，但不得记录敏感内容。
4. 更新 README、README-zh、architecture、technical-architecture、changelog。
5. 为新功能加 Feature Flags：`workflowV3`、`loopSteps`、`voiceInput`、`voiceCloudProvider`。
6. 先对内部测试用户开放，观察稳定性后再默认启用。

交付：
- Windows x64 可验证构建。
- 数据迁移与回滚手册。
- 用户帮助和隐私说明。

---

## 9. 建议的目录演进

第一轮可按以下方向组织，不必一次性搬动所有旧文件：

```text
engine/
  schema/
    src/
      flow.ts
      step.ts
      element.ts
      variable.ts
      dataset.ts
      run-policy.ts
      migration.ts
      validation.ts
      io.ts
      index.ts
  recorder/
    src/
      capture/
      coalesce/
      planning/
      evidence/
  resolver/
    src/
  executor/
    src/
      control-flow/
      actions/
      run-state/
      policies/
      artifacts/

src/
  application/
    workflow-repository.ts
    run-coordinator.ts
    evidence-repository.ts
    interaction-gateway.ts
  browser/
    browser-session-manager.ts
    engine-bridge.ts
  voice/
    voice-service.ts
    providers/
      stt/
      tts/
  ai/
    proposal-service.ts
    takeover-service.ts

renderer/
  process/
    process-state.js
    canvas-controller.js
    inspector.js
    evidence-panel.js
    run-timeline.js
  voice/
    voice-controller.js
    voice-panel.js
```

目录迁移应在模块边界稳定后进行，避免“为了目录整洁”产生大量无关 diff。

---

## 10. 跨阶段质量要求与验收矩阵

| 维度 | 必须验证 |
|---|---|
| Backward compatibility | v0/v1/v2 Flow 加载、迁移、保存、回放 |
| Evidence integrity | observed 不变；raw sidecar 不被 AI 改写 |
| Schema correctness | 非法引用、循环上限、secret、路径穿越、未知版本拒绝 |
| Browser lifecycle | 多 tab、popup、tab close、navigation、CDP reconnect |
| Run lifecycle | start/pause/resume/stop/fail/cancel、异常退出状态 |
| Process editing | 修改、撤销、冲突、刷新、重新加载 |
| AI safety | Proposal diff、baseVersion、domain policy、secret redaction、postcondition |
| Voice privacy | 默认静音、权限、取消、音频保留、敏感转写过滤 |
| Windows packaging | Electron、音频设备、系统 TTS、麦克风权限、ffmpeg 资源 |
| Performance | 长流程内存、事件数量、截图/音频 buffer 生命周期、UI timeline 虚拟化 |

最低自动化命令：

```powershell
npm run build
npx tsc --noEmit
npm test
```

新增测试建议：
- `tests/schema-v3.test.mjs`
- `tests/control-flow.test.mjs`
- `tests/run-coordinator.test.mjs`
- `tests/process-commands.test.mjs`
- `tests/voice-intents.test.mjs`
- `tests/workflow-migration-fixtures/`

端到端场景至少包括：
1. 录制两系统、多标签页业务流程，生成 sidecar 和 Flow。
2. Process 中改 label、拆组、添加 condition、loop、HumanTask。
3. 使用 Dataset 执行有限 forEach。
4. Run 在人工任务处暂停，用户确认后恢复。
5. 故意制造 locator 失败，AI takeover 在允许域内继续并生成 evidence。
6. 接受 repair proposal，形成新 Flow 版本并独立 Test。
7. 使用语音添加备注、查询失败原因、提出一个结构修改并人工确认。
8. 关闭应用后重新打开，Flow、Run 历史和 Evidence 引用仍一致。

---

## 11. 风险与不建议做的事

1. **不要一次性把所有 group/step 重写成通用 DAG。** 这会同时影响 migration、Executor、Process graph、AI takeover 和旧 Flow。先在 v3 中增强语义，等运行时稳定再考虑独立 transitions。
2. **不要让 UI、Pi 和 Executor 各自维护一套流程解释。** Condition/loop 的唯一执行语义必须来自 ControlFlow adapter。
3. **不要把录制 evidence 和可执行 Flow 合并。** 两者的生命周期和可变性不同。
4. **不要把目标定位器变成自由文本。** 这会丢失 ElementRef 的核心证据。
5. **不要让语音识别直接调用 Playwright。** 语音必须经过 InteractionGateway、命令 schema、权限策略和确认。
6. **不要把“AI 一定能执行完成”作为产品目标。** 目标应是可控恢复、透明失败、证据完整、可审计。
7. **不要在第一版实现 always-on/wake-word。** 先验证 Push-to-talk 的真实价值和隐私体验。
8. **不要把音频、长截图帧、完整 DOM 快照写入 Flow JSON 或 tasks.json。**
9. **不要将新 schema kind 提前暴露给 UI。** 只有 Executor 已实现并通过测试的 kind 才能成为可创建的节点。
10. **不要把语音转写文本当成用户确认。** 关键动作必须通过明确 UI 确认或既定权限策略。

---

## 12. 推荐优先级与最终决策

如果资源有限，建议按以下顺序：

| 优先级 | 事项 | 原因 |
|---|---|---|
| P0 | Workflow/Run/Evidence 三种数据边界 | 后续所有能力的基础 |
| P0 | Schema v3 additive migration + contract tests | 避免未来每加一种 step 就破坏旧流程 |
| P0 | Process 单一持久化入口 + Inspector | 解决当前编辑一致性与证据丢失风险 |
| P1 | ControlFlow adapter + Loop/HumanTask | 让复杂流程成为可执行的正式能力 |
| P1 | Run timeline + Proposal diff | 让 AI 和执行过程可审计 |
| P1 | AI takeover 分支感知、tab 能力和 evidence 回传 | 与多系统业务流程直接相关 |
| P2 | Push-to-talk 语音命令和 TTS | 低风险验证语音交互价值 |
| P2 | 语音辅助 Workflow Authoring | 依赖 Proposal/Inspector 成熟 |
| P3 | 独立 DAG/高级编排、wake word、复杂语音代理 | 只有真实用户需求验证后再投入 |

**建议先批准的技术决策：**

- 继续以 FlowLink Flow IR 作为唯一可执行工作流定义；FlowForge sidecar 继续作为证据档案。
- 采用渐进式 Schema v3；先增加 loop、forEach、humanTask、retry/failure/evidence policy 和 Dataset。
- 暂不引入独立 BPMN 或全量 DAG；保留 group 容器，统一由 ControlFlow adapter 解释 condition/loop。
- Process Tab 升级为 Workflow Studio，Canvas + Inspector + Evidence + Run Timeline 四个核心面板。
- 所有编辑、AI 修改、语音修改都经过统一 Workflow Command/Proposal 管道。
- 语音先做 Push-to-talk、STT/TTS provider abstraction 和安全的 Interaction Gateway；不做常驻监听，不允许语音绕过 Executor。
- Run、Evidence、Workflow Definition 分开持久化，并以稳定 ID 关联。

这样演进可以最大限度复用现有 Electron/WebContentsView、Playwright CDP、Recorder、Resolver、Executor、Pi worker 和 FlowForge evidence archive，同时为复杂流程、AI 协作和语音交互建立统一的长期架构。
