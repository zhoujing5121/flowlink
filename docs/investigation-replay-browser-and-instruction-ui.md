# 调查报告：回放浏览器显示 / 停止语义 / 步骤类型与文本 / Instruction 字段 / 类型下拉 / 条件分支画布

> 性质：**调查与计划文档**（2026-11-15，基线为 master + 已实现的登录分支改动）。
> 每项按「现状（代码路径）→ 原因 → 建议计划」组织。行号以调查时工作区为准。
> **实施状态：第 1 项（方案 A + 渲染端 hide 清缓存）、第 3 项（来源徽标 + 中文映射，
> 用户新增步骤标 Manual）、第 5 项（类型下拉 + 字段启停）已于 2026-11-15 实施；
> 第 2、4、6 项仍为计划。**

---

## 1. 回放时浏览器区域没有显示 —— 原因

### 可见性机制（三态合取）

内嵌浏览器是主进程的 `WebContentsView`，可见性由 `syncBrowserVisibility()`（`src/main.ts:211`）决定，三个条件缺一不可：

```
visible = (view === browserView) && browserSurfaceVisible && browserBounds 有效(>1px)
```

- `browserSurfaceVisible = true` 的来源：渲染端 `browser:setBounds`（`renderer/bridge.js:359` `reportBrowserBounds()`）、`browser:switchTab`、`createNativeBrowserTab(activate=true)`。
- `browserSurfaceVisible = false` 的来源：`browser:hide` IPC；**`resetBrowserTabs()`（`src/main.ts:355-358`，无条件隐藏）**。

### 回放路径上的时序（问题所在）

`playback:run`（`src/main.ts:1295`）每次都会先执行 `await resetBrowserTabs(startUrl)` → 视图被隐藏、`browserSurfaceVisible=false`。而渲染端重新点亮它的唯一途径是重新上报 bounds，但：

1. `reportBrowserBounds()` 有**几何去重**（`renderer/bridge.js:378`：`boundsKey === lastBrowserBoundsKey` 直接 return）。Test 布局在回放期间几何不变，`ResizeObserver(#browserFrames)` 不触发；即使因步骤列表渲染再次走到 `mountBrowserSurface()`（每个 `playback:step` 事件都会触发 `renderSummaryWorkspace` → `app.js:2309-2311` 重新挂载），几何未变 → **去重短路，`browser:setBounds` 不发送** → 主进程保持隐藏。
2. 时序对照：`runFlowlinkTest`（`renderer/bridge.js:1254-1279`）先 `renderSummaryWorkspace()`（此时上报成功、surfaceVisible=true），**随后** `playback:run` → `resetBrowserTabs` 把它关掉；此后整个回放期间没有任何代码再把它打开。
3. 唯一例外：流程含 `openTab` 步骤时，`createNativePlaybackPage` → `createNativeBrowserTab(activate=true)`（`src/main.ts:279-293`）会重新置 true 并 `ensureBrowserBounds()`。**所以含 openTab 的流程回放时浏览器"又出现了"，而 navigate 开头的流程全程看不到浏览器**——这解释了现象的间歇性。

### 伴生缺陷（同一族问题）

`browser:hide`（frames 隐藏或尺寸 <2px 时上报，`bridge.js:364-371`）不清除 `lastBrowserBoundsKey`："隐藏 → 同尺寸恢复"场景同样被去重卡死（例：`bridge.js:389` 注释提到的对话框前隐藏原生视图）。

### 修复计划（按成本递增，推荐 A）

- **方案 A（推荐，主进程最小改动）**：`playback:run` 在 `resetBrowserTabs` + `attachPlaybackPages` 之后显式 `browserSurfaceVisible = true; ensureBrowserBounds(); syncBrowserVisibility()`（与 `createNativeBrowserTab` 同语义）。Test 运行是用户主动触发，浏览器区域必然在 Test 布局中可见。
- **方案 B（渲染端）**：`F.browser.hide()` 后清空 `lastBrowserBoundsKey`；主进程在 `resetBrowserTabs` 完成后广播 `browser:boundsStale`，渲染端收到后强制重报（绕过去重）。
- **方案 C（语义修正，改动最大）**：`browserSurfaceVisible` 改为渲染端独占的 level-triggered 状态，`resetBrowserTabs` 不再翻转它。需回归验证录制启动路径（原 hide 是为避免重排期间旧位置闪现）。

---

## 2. 回放被用户手动停止后，后续步骤是否还会执行

### 结论：步骤边界上已有保证；"看起来还在执行"来自两处缺口

机制链：`playback:stop`（`src/main.ts:1383-1395`）→ `playAbortController.abort()` → 并 `await playPromise`。执行器主循环**每步开始前**检查中止信号（`engine/executor/src/run.ts:584`）：已中止 → 记一条 skip 并 `break`，**后续步骤不再执行**。`stopOnFailure: true` 也已在 `playback:run` 传入。

用户观感"停止后仍在执行"的真实来源：

1. **在飞步骤不被中断**：Playwright 动作（timeoutMs 15s）、断言轮询（EXPECT_WAIT_MS 5s）、expect 校验、NO_EFFECT 像素探测均不感知 abortSignal（个别等待有意不监听并有界，如 OPTIONAL_NAV_WAIT_MS 800ms）。点 Stop 后当前步骤最长可再运行约 20s，期间浏览器里的操作肉眼可见地继续发生。
2. **UI 收敛缺口**：`stopFlowlinkTest`（`bridge.js:1281-1293`）只把 running 步骤标为 fail('Stopped by user')；执行器最终 `steps` 数组只含已执行步骤 + 1 条中止 skip，其余步骤在 `testResults` 里**永远停留 pending**（`playback:step` 把 skip 映射为 pending，`bridge.js:1540-1542`），列表看起来像"还没跑完"。

### 改进计划（如需实施）

- 执行器：给 `runAction` / `resolveTarget` / `runAssertion` / `verifyExpect` 增加 abort 感知（与 abort Promise race，抛 `StepFailure('ABORTED')`），Stop 后约 100ms 内中断在飞步骤。
- 报告语义：中止时为所有剩余步骤补 skip 结果，或在 `RunResult` 增加 `aborted` 标志；渲染端把残留 pending 收敛为 stopped 状态。
- 两项均向后兼容（新增错误码/标志，不改 pass/fail 语义）。

---

## 3. 步骤旁的 Manual/Automation 徽标 与 操作类型 → 展示文本映射

> 需求澄清（2026-11-15）：Manual/Automation 指**步骤旁边的来源徽标**（画布/列表的标记），
> 不动 JSON 的 `execution` 字段——目标是：**录制原始流程的步骤显示 Manual（人工录制来源），
> REFINED（AI 细化）流程的步骤显示 Automation**，并配操作类型→可读文本的映射。

### 现状

- 徽标现在由 `step.execution === 'manual'` 驱动（`canvasStepNode`，`renderer/app.js:962-967`；`syncProcessFlowPresentation` 透传，`app.js:3588`）。录制器从不设置 `execution` → 所有步骤（录制的和 REFINED 的）一律显示 Automated。
- `execution` 字段本身另有真实用途（回放暂停等人工确认，`run.ts:839`），**保持不动**，只是不再用它驱动这个图标。
- 展示文本由 `processStepLabel`（`app.js:3443-3466`）合成英文短语；**完全没有使用 `step.label`**——尽管细化提示词已要求生成业务语言 label，UI 却丢弃了它。Test 视图 `testStepLabel`（`app.js:894-904`）同样显示裸 kind。

### 徽标的数据来源（现成，无需新增字段）

REFINED 孪生是**独立的录制条目**：`persistMergedFlow`（`src/main.ts:643-673`）以 `isMerged: true` 写入 RecordingMeta，名字 `REFINED-MMDD-HHmm`。因此 UI 里每个录制项天然能二分：

| 流程来源 | 徽标 |
|---|---|
| 原始录制（`recording.isMerged` 为空/false） | Manual（人工录制） |
| REFINED 孪生（`recording.isMerged === true`，或 flow.title 以 `REFINED` 开头兜底） | Automation |

边界情况（需产品定夺，技术无障碍）：用户在 Process 编辑器**手动新增**的步骤属于哪种来源——建议跟随所在流程的整体徽标，或单独给一个 "Edited" 小徽标。

### 实施计划（纯渲染层）

1. `canvasStepNode`（`app.js:962-967`）与 `syncProcessFlowPresentation`（`app.js:3588`）：`manual` 判定从 `step.execution === 'manual'` 改为流程来源判定（item 对应录制的 `isMerged` 取反）。图标/样式复用现有 `execution-mode-icon`。
2. **操作类型 → 文本映射表**（renderer 常量表，替换 `processStepLabel` / `testStepLabel` 两处合成逻辑）：

   | kind | 展示文本 |
   |---|---|
   | navigate | 打开页面 |
   | click | 点击 |
   | input | 填写 |
   | select | 选择 |
   | upload | 上传 |
   | hover | 悬停 |
   | key | 按键 |
   | scroll | 滚动 |
   | drag | 拖拽 |
   | wait | 等待 |
   | assert | 校验 |
   | condition | 条件判断 |
   | extract | 提取 |
   | dialog | 处理弹窗 |
   | openTab / switchTab / closeTab | 打开 / 切换 / 关闭标签页 |

   渲染优先级：`step.label`（REFINED 流程已有 AI 生成的业务语言 label，优先使用）> 映射表（kind + target.description）。仅改 `renderer/app.js`，无需动 schema / 引擎 / 主进程。

---

## 4. Instruction 展开字段 ↔ Flow JSON 字段对照

数据流：面板数据来自 `processFlow`（`flow.load` 加载的 Flow JSON）→ `syncProcessFlowPresentation`（`app.js:3583-3595`）生成展示模型 `item.steps`（文本）与 `item.stepDetails`（字段）。四个输入框定义在 `renderer/index.html:1670-1677`。

| 界面字段 | 绑定 | 对应 JSON | 说明 |
|---|---|---|---|
| 操作内容 | `data-step-field="text"` | **无直接字段**。初始值 = `processStepLabel(step)` 合成文本（`item.steps[index]`），**不是 `step.label`** | 编辑只写本地 `item.steps`，从不写回 Flow 的 `step.label` |
| 操作类型 | `data-step-field="type"` | `step.kind`（"click"/"input"/…，原始英文枚举） | 编辑只写本地 `stepDetails` |
| 目标 | `data-step-field="target"` | `step.target.description`（ElementRef 的可读描述，可为空串） | 真正的定位是 `target.candidates / observed / fingerprint` 整包录制证据；此输入框只显示 description 字符串，编辑**不影响真实定位** |
| 填写内容 | `data-step-field="value"` | 仅 `input.value`（形如 `{{input_1}}` 的模板串）；其余 kind 一律空串 | `select.value` / `upload.files` / `dialog.promptText` 均未暴露 |

补充：

- 旧版兜底 `ensureStepDetails`（`app.js:3411-3430`）是 mock 启发式（按中文前缀猜 输入/选择/上传/点击），仅在真实 Flow 未加载时使用。
- 编辑事件 `bindStepEditor`（`app.js:3801-3817`）只更新**本地草稿**；实际回放 `runFlowlinkTest` 永远 `F.flow.load` 已保存的 Flow 文件（`bridge.js:1262`）——**Instruction 的四个编辑框目前对真实回放无影响**（显示层草稿，见第 5 项计划一并修正）。

---

## 5. 操作类型改为下拉列表

### 现状

type 是自由文本 `<input>`，可输入任意字符串；草稿重建时 `normalizeStepKind`（`app.js:~3720`）把非法值兜底成 `"action"`。

### 计划（推荐复用 Process 手动步骤编辑器机制）

Process 标签页已有成熟的按类型编辑器：`fieldsByKind`（`app.js:4460`）定义各类型的字段集、按 kind 显隐字段（`app.js:4480`）、execution 处理（`app.js:4516`），且经 `flow.updateSteps` 校验管道持久化（`persistProcessFlow`，`app.js:3597`）。计划：

1. `index.html` 的 type `<input>` 换成 `<select>`，选项 = schema 支持的 step kind 枚举（navigate / click / input / select / key / hover / scroll / drag / upload / wait / assert / condition / extract / dialog / openTab / switchTab / closeTab；`script` 与手动编辑器口径一致不提供）。文案用第 3 项的中文映射表（value=kind）。
2. **切换 type = 步骤结构重建**：各 kind 必填字段不同（click 需 target ElementRef、navigate 需 url…）。建议策略：切换时清空该步并按新类型展示对应字段表重新填写；target 只能从录制元素库选择——与现有约束一致（"Manual element actions must reference an ElementRef already captured by recording"，`docs/architecture.md:109`）。
3. 编辑必须走 `processFlow` + `flow.updateSteps` 持久化（当前 `bindStepEditor` 本地草稿路径不落盘、不影响回放，见第 4 项），否则下拉改了也不生效。
4. 预计改动：`renderer/index.html` 模板 + `renderer/app.js`（`bindStepEditor`、`fillInstructionPanel`），可把 Process 编辑器的字段表抽成共享模块。**不动 schema / 主进程**。

---

## 6. 为什么 Condition 不能让 Process 画布出现多条路径

三层约束叠加，不是单点限制：

### ① 数据模型（schema）

Flow 顶层是**有序数组**（`steps: Step[]`，group 为 `{kind:'group', steps:[...]}`），不是图。condition 的表达力被契约（`engine/schema/src/schema.ts` `validateFlowContract`）严格限定：

- condition 必须直接位于某个顶层 group，且必须是**该 group 的最后一步**；
- `trueGroupId` / `falseGroupId` 只能指向**已存在的非空**顶层 group；
- 缺省分支 = 结束整个运行。

即"分支"只是 group 之间的**跳转指针**，不存在平行路径容器——"已登录直达"这类空分支组本身非法（这正是登录重构采用「网关 condition + 容忍式登录组」而非三条平行分支的原因，见 `docs/handover-login-branch-and-parameters.md` §3）。

### ② 执行语义（executor）

group 执行完**自然落到数组中的下一个兄弟项**（`run.ts` 扁平化顺序推进 + `branchCursor` 跳转，`run.ts:814`）；每个顶层 group 每次运行最多进 3 次（`FLOW_LOOP_LIMIT`）。执行器里没有"路径"对象，只有一维游标。

### ③ 渲染模型（renderer）

Process 画布由 `ensureProcessGroups`（`app.js:3468-3493`）→ `canvasGroupCardTemplate` / `canvasStepTemplate`（`index.html:1470-1476`）渲染，是**线性卡片堆叠**：顶层 group 依次排列、卡片内部是步骤行列表。没有任何边（edge）/分叉的 DOM 或绘制逻辑；condition 只是所在 group 末尾的一行文本（`processStepLabel:3461-3463`："Condition · visible · true → X · false → Y"）。

### 若要可视化分支：可行性结论与分档方案

**核心结论：多路径展示不需要改契约——渲染层从现有数据模型即可推导出忠实于执行语义的分支图。** 契约限制的是"分支的表达力"（只能跳已存在的非空顶层组），不是"能不能画"。验证依据：condition 的跳转边全部是「顶层组 → 顶层组」（`run.ts:509-518` `groupStartIndices` 只登记顶层组，`branchCursor` 只能落在组起点），因此图结构可完整推导：

- **节点** = 顶层 group（+ 虚拟 Start / End）；
- **顺序边**（fall-through）= Gi → Gi+1（数组顺序，隐式）；
- **条件边** = 末步为 condition 的组 → `trueGroupId` / `falseGroupId`（省略的目的地 = End 节点）；
- **回边**（跳到更早的组）= 循环，需视觉区分并标注 3 次上限（FLOW_LOOP_LIMIT）。

以登录流程为例可画出菱形：G1(网关) --true--> G3(业务)、G1 --false--> G2(登录)、G1 --顺序--> G2、G2 --顺序--> G3。既有数据完全够画。

**分档方案（成本递增）：**

- **档 1：仅渲染层（推荐，可完全实现多路径画布）** — schema / 执行器 / 契约零改动，回放语义不可能回归。画布改为节点-边布局：主干按数组顺序排，条件分支目标画成并行泳道/缩进列，汇合处画顺序边；End 节点承接省略目的地的条件边；回边用虚线+循环标记。工作量集中在 `renderer/app.css`（布局）+ `app.js`（`ensureProcessGroups` 派生边数据、`canvasGroupCardTemplate` 扩展边绘制，可用 SVG overlay）。Process 的分组操作（合并/移动/重命名，`app.js:5087-5193`）基于同一有序数组，不受影响。
- **档 2：小幅放宽契约（可选润色，非必需）** — 允许**空 group 作为跳转目标**：执行器机制上已兼容（跳到空组起点 = 落到下一个兄弟项），只是契约禁止；放开后 AI/用户可以显式表达"false → 直接跳过某段"，画布上呈现为直通锚点。需改 schema 契约校验 + `config/prompts.json` 里 systemPrompt 的 condition 契约描述（"may only branch to existing non-empty top-level groups"）。纯放宽、向后兼容、无迁移。
- **档 3：真正平行分支语义（不建议）** — 任意嵌套条件 / 组中条件 / 显式边模型：schema 重构 + 迁移 + 执行器路由重写 + AI 提示词重写 + 两个标签页重做。与现有"condition 必须是组末步、只能跳已存在组"契约正面冲突，收益不成比例。

### 对 Instruction 标签页的影响评估

- **档 1 下：功能上零影响。** Instruction 从同一个有序数组渲染（`ensureProcessGroups` → 扁平分组列表），画布改图不影响数组本身；`stepDetails` 的索引对齐、编辑、分组删除/移动逻辑全部基于连续区间，不触碰。
- **建议的轻量配套（可选）**：在 Instruction 的 condition 行（以及它所在分组的标题）加 true/false 目标标注（配合第 3 项中文映射表，如"条件判断：目标页已出现？是→业务操作 / 否→登录"），让线性文档读者也能感知分支存在。不做也不影响正确性。
- **档 2 下 Instruction 影响仍为零**（空组没有步骤，Instruction 自然不显示；仅在 Process 画布多一个锚点节点）。
- **档 3 下 Instruction 需重做**（线性列表模型本身要重新定义），这也是不建议档 3 的原因之一。

---

## 附：本报告未做的事

- 未修改任何代码 / 配置 / 提示词。
- 第 1 项的方案 A 与第 2 项的 abort 感知改动量小、彼此独立，可先行；第 3/5 项共享中文映射表，建议同批实施；第 6 项建议仅做渲染层第一档。
