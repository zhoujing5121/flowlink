# 调查报告：录制闪烁 / step 类型（condition·loop）/ Instruction 表现形式 / AI 接管强化

> 性质：**调查与方案文档**（2026-11-17，基线 master @ 3243482 + 工作区未提交改动）。
> 每项按「现状（代码路径）→ 原因分析 → 方案」组织。行号以调查时工作区为准。
> 本文档未修改任何代码；四项互相有依赖，依赖关系见文末「§5 四项的联动关系」。

---

## 1. 录制时页面闪烁、用户操作偶发失效

### 1.1 现状：录制期间的截屏链路（完整还原）

录制「视频」的真实实现是 **PNG 帧合成 webm**，链路如下：

1. **主进程**：`startRecordingCapture()`（`src/main.ts:439-448`）在录制启动后开一个
   **800ms 的 `setInterval`**，每次调 `captureRecordingFrame()`（`src/main.ts:410-437`）。
2. `captureRecordingFrame()` 对当前活动的 `WebContentsView` 调
   **`view.webContents.capturePage()`**，然后：
   - `image.toPNG()` 同步编码 → 写盘（`recording-*/record/video/frame-NNNN.png`）；
   - `image.toDataURL()` 再次同步编码 → 通过 IPC 把**整页尺寸的 dataUrl 字符串**
     （数百 KB～数 MB）发给渲染进程（`recording:captureFrame` 事件）。
3. **渲染进程**：`renderer/bridge.js:1583-1618` 收到后 `new Image()` 解码，画到一个
   **不在 DOM 中的 960×540 canvas**（`startRecordingMedia`，`bridge.js:1015-1040`），
   canvas 经 `captureStream(10)` + MediaRecorder 合成 webm；每帧 dataUrl 还会被
   **全量 push 进 `media.screenshots` 数组**（内存常驻）。
4. 停止时 `stopRecordingMedia` 收尾 webm，`recording:saveVideo` 落盘；
   PNG 帧目录与首帧 poster 存入 `RecordingMeta.frames/posterFile`。

注意：**这个 canvas 不上屏**——800ms 截屏的唯一用途就是合成 webm 视频和帧目录，
录制过程中 UI 并不显示这些帧。

另有第二路截图（嫌疑较小）：录制器每捕获一个动作，用 Playwright（CDP）
`page.screenshot()` 截元素裁剪图 + 整页步骤图（`engine/recorder/src/record.ts:764-779`、
`record.ts:895`）。CDP 截图通常不干扰呈现，但若闪烁与「每次点击」强相关而非周期性，
则需把这路也纳入验证。

### 1.2 原因分析（按证据强度排序）

**主嫌疑：800ms 周期的 `webContents.capturePage()` 管线**，两个机制叠加：

- **机制 A（可见闪烁）**：`capturePage()` 需要 GPU 合成面读回（CopyFromSurface）。
  Windows + WebContentsView + 硬件加速下，读回会迫使合成面重建/同步，驱动兼容性
  差的机器（尤其集成显卡/Optimus 笔记本）会出现整页闪白/闪黑一帧——这是 Electron
  的已知问题族。闪烁「经常出现」且与录制强相关，与此吻合。
- **机制 B（操作失效）**：`NativeImage.toPNG()` 和 `toDataURL()` 是**主进程 UI 线程
  上的同步编码**。整页 PNG 每次编码可达几十毫秒，期间主进程（Electron browser
  process）停摆——而它正是整个窗口（含内嵌浏览器视图）的输入路由与合成协调者。
  输入事件在停摆窗口内被延迟乃至丢弃，表现为「点了没反应/闪烁时操作不生效」。

次生影响：每 800ms 一条大 dataUrl IPC + 渲染端 `Image` 解码，造成渲染进程周期性
jank；`media.screenshots` 无上限留存每帧 dataUrl，长录制（30 分钟 ≈ 2250 帧）内存
可膨胀到 GB 级。

### 1.3 验证方案（实施前先做，10 分钟级别）

1. 给 `startRecordingCapture` 的定时器加临时开关（环境变量
   `FLOWLINK_DISABLE_FRAME_CAPTURE=1` 时不开 setInterval），录一段真实操作：
   **闪烁消失、点击全部生效** → 归因成立，实施方案 A。
2. 若仍有闪烁：只关 `page.screenshot`（recorder 侧），观察闪烁是否改为「跟随点击」
   → 启用对 recorder 截图的同类替换。

### 1.4 修改方案

**方案 A（推荐）：用 CDP screencast 替代 `capturePage()` 轮询**

录制期间每个已附着的 Playwright Page（`engine.pageFor` 已有缓存）上开
`CDPSession → Page.startScreencast`（`format: jpeg/png`、`maxWidth/maxHeight ≈ 1280`、
`everyNthFrame` 可控）：

- 帧由**页面自己的合成器推送**，到达时已是编码位图——没有主线程读回、没有主进程
  同步 PNG 编码，机制 A/B 同时消除（这正是 DevTools 设备预览的实现方式，可开多年
  不闪屏）。
- 帧事件自带 `sessionId`/页签上下文；多标签页各自订阅，事件里带 `tabId`，渲染端
  现有的按标签页打标签逻辑（`bridge.js:1598-1608`）直接复用。
- poster/帧目录兼容：主进程从 screencast 帧里抽样写盘（如每 N 秒一帧 + 停止帧），
  `RecordingMeta.frames/posterFile` 结构不变，Record 标签页无感。
- IPC 传 base64/buffer 而非 dataUrl 字符串；渲染端用 `createImageBitmap(blob)` 画
  canvas（解码不占主线程）。
- 停止时对全部会话 `Page.stopScreencast`。
- 顺手修掉 `media.screenshots` 全量留内存的问题（只留抽样关键帧）。

改动范围：`src/main.ts`（capture 管线替换）+ `renderer/bridge.js`（帧消费）+
`src/engine-bridge.ts`（暴露按 Page 取 CDPSession 的能力，若还没有）。schema/recorder/
executor 不动。

**方案 B（保守缓解，不推荐单独做）**：保留 `capturePage` 但降频（≥2s）、只截缩放后
区域、IPC 改传 buffer、渲染端异步解码。闪烁频率下降但机制 A/B 仍在。

**方案 C（产品取舍）**：砍掉帧视频，只保留每步截图 + poster（当前 webm 有效帧率只有
1.25fps，信息量与步骤截图高度重叠）。若产品确认不需要视频，这是零闪烁的最低成本路径。

---

## 2. 录制流程的 step 类型：condition / loop 支持情况（调查结论）

### 2.1 类型全集

`engine/schema/src/schema.ts:202-387` 共 18 种动作 + 递归 `group`：
`navigate / click / input / select / key / hover / scroll / drag / upload / wait /
assert / condition / extract / script / dialog / switchTab / openTab / closeTab`。

### 2.2 condition：**支持**，但是「组末跳转」形态

- 数据模型（`schema.ts:292-298` + 契约 `schema.ts:573-607`）：condition = 目标元素 +
  断言 + `trueGroupId/falseGroupId`。契约限制：**必须直接位于顶层 group 且是该组
  最后一步**；分支只能指向**已存在的非空顶层 group**；缺省分支 = 结束整个运行。
- 执行语义（`engine/executor/src/run.ts:826-847`、跳转收尾 `run.ts:1042-1066`）：
  扁平游标模型，condition 求值后把游标设到目标组起点，**允许往回跳**。
- 来源：**录制器从不产生 condition**（recorder 全目录无 trueGroupId 引用）。目前
  condition 只有两个入口：① AI 细化（`config/prompts.json` 的登录网关结构，REFINED
  流程标配）；② 用户在 Process 标签页「手动新增步骤」编辑器里创建——该编辑器支持
  `condition` 的完整字段（含 true/false 组目标下拉与元素库引用，
  `renderer/app.js:5283-5300`、`5436`）。**Instruction 标签页的类型下拉里有
  condition，但没有 true/false 目标字段，等于不可用**。

### 2.3 loop：**没有显式循环类型**，只能用 condition 回边模拟

- condition 指向更早的组即构成回边循环，但受护栏限制：**每个顶层 group 每次运行
  最多访问 3 次**，超出即 `FLOW_LOOP_LIMIT` 失败（`run.ts:529、586-597`、
  `types.ts:40`）。所以是「有界重试」不是真正的 while/for。
- **没有数据驱动循环**（如「逐行处理 CSV」），schema 无对应表达。
- 渲染层已能画分支：Process 图（`renderer/flow-graph.js` `buildGraph`）把组末
  condition 提取为菱形判断节点，画「是/否」分支边，回跳边标虚线（受 3 次上限约束
  的语义有标注）。
- **AI 接管目前不懂分支**：`startAiTakeover` 把剩余步骤线性切片执行
  （`src/ai-takeover.ts:361-363`），condition 只被投影成一句「Check … on …」，
  true/false 跳转完全不生效（详见 §4）。

---

## 3. Instruction 页面的表现形式（现状 + 改版方案）

### 3.1 现状还原

- **行文本**：分组（按标签页/URL）+ 每步一行中文句子。数据来自
  `flowStepToText`（`renderer/bridge.js:1109-1162`，形如「点击【提交】」「在【用户名】
  中填写：{{input_1}}」）；Process 流程加载后走 `processStepLabel`
  （`renderer/app.js:4257-4283`，**优先用 AI 生成的业务语言 `step.label`**）。
- **展开字段**（`renderer/index.html:1686-1735` 模板；`fillInstructionPanel`
  `app.js:1798-1843`）：操作内容（textarea）/ 操作类型（下拉）/ 目标（input）/
  填写内容（input），按类型启停（`STEP_ELEMENT_KINDS/STEP_VALUE_KINDS`，
  `app.js:1620-1635`）。

### 3.2 两个核心缺陷

1. **对终端用户不够友好**：表格化的「类型/目标/填写内容」仍是技术形态；分组标题是
   `Tab 1 · host/path` 而非业务阶段名（REFINED 的 group.label 有业务名，但 Instruction
   的分组是本地按 URL 重算的，没有用 group.label）。
2. **对技术用户是「假编辑」——编辑不落盘、甚至有害**：
   - `bindStepEditor`（`app.js:4615-4664`）只改本地草稿 `item.steps/stepDetails`，
     **从不写回 Flow 文件**（2026-11-15 调查报告 §4 已记录，至今未改）。
   - processFlow 已加载时，`rebuildItemTestFlow`（`app.js:4591-4613`）优先用
     processFlow——**Instruction 的编辑被整个忽略**；未加载时走
     `rebuildTestFlowFromItem`（`app.js:4553-4589`）从草稿重建测试流，其中「目标」
     被降级为**单一 text 候选的伪 ElementRef**——用户改一次「目标」，等于把录制的
     完整证据链（fingerprint/testid/role/多候选）扔掉换成文本匹配，回放可靠性
     直接受损。
   - 技术字段缺失：timeout / isOptional / settle / expect / 分支目标 / select 多值 /
     upload 文件 / wait 条件与时长都改不了。

### 3.3 方案（推荐：保留列表骨架，做「双层呈现 + 真落盘」）

**结论先行：不建议做完整纯文本 DSL。** 纯文本 ↔ Flow 结构的双向解析歧义大，且元素
证据链（observed/candidates/fingerprint）在纯文本里无法表达，等于重造一门语言且必然
丢失回放可靠性；用户真正想要的「纯文本感」由「行内直接改一句话」承载即可。

三层设计：

**① 行层（终端用户）——每步一句自然语言，行内直接编辑**
- 行文本统一改为 `step.label` 优先（原始录制无 label 时用现有合成文案兜底）。
- 行内编辑（textarea/contenteditable）= **写回 `step.label`**，走 processFlow +
  `flow:updateSteps` 持久化（该管道已有校验与 .bak 备份，Process 分组操作在用，
  `persistProcessFlow` `app.js:4416-4430`）。
- 分组标题改用 `group.label`（业务阶段名），Tab/URL 信息降为副标题徽标。
- 加「AI 润色步骤描述」一键：调用现有 Pi 管线，指令限定「只为每步生成 label，
  不动结构」，满足「纯文本可读可改」的 80% 需求。

**② 技术抽屉（技术用户）——按 kind 的结构化字段面板，编辑即落盘**
- 展开/点开每步出现属性面板：复用 Process 手动步骤编辑器的 `fieldsByKind`
  （`app.js:5283-5300`），并增补 timeout / isOptional / settle / expect /
  condition 分支目标 / wait 条件与时长 / select 多值 / upload 文件清单。
- **「目标」改为证据查看器**：显示 crop 截图、候选列表（testid/role/text…）、
  fingerprint 摘要；不允许自由文本改定位（现在这条路径本来就是坏的）；需要换目标
  时引导「重录该步」或从元素库引用。
- 所有编辑立即走 `persistProcessFlow`（校验失败内联报错回滚，同 Process 拆组体验）。
- **前置修复**：Instruction 编辑管线挂到 processFlow（打开 Instruction 时按需
  `hydrateProcessFlow`），删除草稿重建路径 `rebuildTestFlowFromItem` 的伪 target 逻辑。

**③ 大纲/纯文本视图（可选轻量）**
- 只读（或仅 label 可编辑）的纯文本大纲，按组折叠，可复制粘贴——给文档/评审场景；
  不承担结构编辑。

改动范围：`renderer/index.html`（模板）、`renderer/app.js`（fillInstructionPanel /
bindStepEditor / 分组标题）、复用既有 `flow:updateSteps` 管道；不动 schema/主进程。
工作量主体在渲染层，风险集中在「编辑落盘」的前置修复。

---

## 4. AI 接管强化：让流程「一定」能被 AI 执行完并生成新流程

### 4.1 现状还原（代码级）

链路：Test 失败 → quickbar「AI Continue」→ `playback:aiContinue`（`src/main.ts:1487-1588`）
→ `startAiTakeover`（`src/ai-takeover.ts:358-618`）：browser-use（pi agent）经 CDP 附着
**同一个内嵌浏览器**（现场保留），把剩余步骤**线性切片**逐个执行；每步任务文本由
`projectStepText`（`ai-takeover.ts:248-305`）投影；完成判定 = `mark_step_done` 工具
（必须带正确 stepIndex + 证据）+ typed 结果 `done=true` 双门槛（`ai-takeover.ts:396-424`、
`523-524`）；每步 1 次重试（`530-540`），单步两败即中止（`569`）。护栏：总 10 分钟 /
每步 150s / 每步最多 14 个 agent 步（`79-81`）。结束时 `playback:aiDone` → 有 AI 完成
证据则**自动**触发 `aiRepairFlowAfterTakeover`（`renderer/bridge.js:1849-1889`、
`1375-1463`）→ `pi:repairFlow`（`main.ts:1056-1126`）重跑细化管线 → 另存 REPAIRED 新录制。

### 4.2 「不总会成功」的具体失败点（按影响排序)

1. **线性投影无视分支**（与 §2 联动）：REFINED 流程都有登录网关 condition。接管从
   失败步线性走到结尾：网关 condition 被投影成「Check visible on …」，agent 对
   「评估」还是「使其为真」理解摇摆；true/false 跳转不生效，不该走的组也会被走。
2. **UNSUPPORTED_KINDS 直接中止**（`ai-takeover.ts:246、492-495`）：
   `upload / switchTab / openTab / closeTab / script` 遇到即停；`wait/userOperation`
   也中止（合理）。**跨系统多标签页流程（本产品核心场景）无法被 AI 完成**——而且
   systemInstructions 明令「Do not open new tabs」，把可行路径也堵死了。
3. **单步两败即弃**：任何硬步骤（页面改版、弹窗、验证码外的交互死角）都会终止接管
   ——「一定执行完成」在现架构下不可能成立。
4. **双门槛的严格性**：模型漏调 mark_step_done / 序号写错 = 整步判负（重试可缓解但
   耗预算）。
5. **secret 缺失**：Reference 页没存密码时，投影里 `{{password}}` 原样保留（
   `renderValue` 渲染失败回退原文，`ai-takeover.ts:214-219`），登录段必然卡死。
6. **预算触顶**：长流程（>10 分钟人工操作量）必然中途停。
7. **repair 证据太薄**（与 §3 联动）：`pi:repairFlow` 只拿到失败步骤的 label+error、
   AI 完成步骤的 label 列表和一句 summary。agent 实际怎么成功的（点了什么、页面现状
   长什么样）没有结构化回传；而修复模型又被禁止发明选择器——于是修复只能调
   wait/timeout/isOptional，**不能重新锚定元素**（schema 明明允许写 candidates/
   fingerprint version+1，管线没用上）。
8. 小缺口：`execution:'manual'` 步骤未被特判（循环里只查 kind），agent 会试图自动化
   人工步骤。

### 4.3 强化方案（分层，可按序落地）

1. **分支感知接管**：接管启动时，主进程先用执行器同款断言逻辑（CDP evaluate）**本地
   求值所有网关 condition**，据此决定线性子序列（跳过不会走的组，报告 skip），再交给
   agent。等价于「接管前先跑一遍路由」。改动集中在 `ai-takeover.ts` 投影阶段。
2. **解锁标签页操作**：把 `openTab/switchTab/closeTab` 从 UNSUPPORTED_KINDS 移除，
   投影补足 url/index 语义；systemInstructions 的「不开新标签页」改为「仅按步骤要求
   开」。browser-use agent 本身具备能力。`upload` 保持中止（或后续走专用通道）。
3. **失败策略升级为「降级自由续跑」**：单步两败后不再 break，改为把剩余步骤的业务
   intent（label 串）合成一个 goal 任务交给 agent 自主完成，仍要求逐步
   mark_step_done（拿不到就整体 goal 级 done）。保留总预算与 abort 护栏。这一条直接
   回应「一定可以被 AI 执行完成」。
4. **证据回传，让 repair 敢改元素**：agent 每步成功后抓 a11y snapshot/交互坐标，
   主进程把 agent 实际命中的元素与元素库匹配（匹配不上则作为新元素条目）写入
   `ai-takeover.json`；`pi:repairFlow` 把这些作为**新证据**注入 instruction，并允许
   修复输出「候选更新」（candidates 回写，observed 仍不可变）。修复从「调等待参数」
   升级为「重锚定 + 调参数」。
5. **闭环验证**：REPAIRED 生成后自动跑一轮 Test（限 N 轮、限预算），全绿才停，失败
   再进入接管/修复循环；UI 明示循环状态与轮次。
6. **体验补丁**：manual 步骤在接管中改为暂停等待用户确认（复用
   waitForUserOperation）；secret 缺失时接管前给出明确提示而不是跑到登录步才失败。

### 4.4 与 §2/§3 的依赖

- §4.1 依赖 §2 的分支语义（接管必须先「懂」condition 才能替执行器走路由）；
- §4.4（证据回传 + 重锚定）依赖 §3 的真落盘编辑（修复产物需要人工可调的兜底入口，
  且 Instruction 的分支目标/label 编辑是 repair 语言的一部分）；
- §3 的「AI 润色 label」反过来提升接管质量：agent 的任务文本就是 label
  （`stepTask` 模板里 stepProjection 的可读性由 label 决定）。

---

## 5. 四项的联动关系与建议实施顺序

```
1 闪烁修复（独立，先验证后换 screencast）
2 类型调查（已完成，无需改动；结论供 3/4 使用）
3 Instruction 改版（前置修复「编辑落盘」是 4 的地基）
4 接管强化（依赖 2 的分支语义 + 3 的落盘编辑 + 4.4 证据回传）
```

建议顺序：**1（当天可完成验证+修复）→ 3 的前置修复（Instruction 落盘）→ 4.1/4.2
（分支感知 + 标签页解锁）→ 3 的双层 UI → 4.3/4.4/4.5（降级续跑 + 证据回传 + 闭环）**。
