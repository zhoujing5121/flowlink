# 执行计划（第二轮，2026-11-17 真机反馈）：录制闪烁根治 / Test 加载稳定 / 步后默认等待 / 单步 AI 接管 / Instruction 菜单与 AI 预设

> 背景：第一轮三项改造（rrweb 录屏、Instruction 改版、AI 接管强化）已完成且 build+tsc 绿。
> 用户真机验证反馈六项，本计划分三个串行执行会话：
> **D1（Opus）= 第 1-3 项（录制稳定性，engine/main）→ D2（Opus）= 第 4 项（单步 AI 接管）→ E（Sonnet）= 第 5-6 项（Instruction/AI 面板 UI）**。
> 执行约束同前：不 commit、不切分支、验证 = `npm run build` + `npx tsc --noEmit`、
> 完成后更新 CHANGELOG.md。行号以调查时工作区为准，可能偏移，以符号定位。

## 第 1 项：录制仍闪烁（有时更严重；用户操作无效已修复）

### 根因分析（已排除项 + 剩余主嫌疑）

已排除：
- 800ms `capturePage` 管线（第一轮已删净，点击丢失随之消失——主线程阻塞机制确认已除）。
- capture.js 页面内 overlay（`engine/recorder/capture/capture.js` 只读 computed style，不创建 DOM）。
- rrweb 注入本身（MutationObserver/监听器，不改渲染）。

剩余主嫌疑（按可能性排序）：
1. **录制器每个动作的 Playwright CDP 截图**：元素裁剪 `screenshotRegion`（`engine/recorder/src/capture-client.ts:442-457`，`page.screenshot({clip})`）+ 整页步骤图（`engine/recorder/src/record.ts` ~895，`pageOfAction(action).screenshot(...)`）。CDP `Page.captureScreenshot` 默认 `fromSurface:true`，与 capturePage 同类的 GPU 表面读回，Windows 上可触发可见闪帧——每个动作两次。
2. **rrweb 每次导航的 full snapshot**：重企业页面上序列化（含 CSSOM 内联）是数百 ms 级 CPU 尖峰，与截图读回叠加时感知更差（解释「有时比之前严重」）。

### 修改方案（D1 实施）

1. **砍掉录制期整页步骤截图**（`step-NNNN.png`）：rrweb 回放已覆盖其用途；元素裁剪保留（证据查看器依赖）。
   - `record.ts` 停止写整页步骤图；`main.ts` stopRecordingSession 的 stepScreenshots 目录读取保留（兼容旧数据，新录制为空数组）。
   - 渲染端 Record 页截图墙在无截图时不显示占位（`bridge.js` 停录组装处删除补位 padding；`app.js` fillRecordPanel 空列表隐藏区块）。rrweb 回放器是新的主展示。
2. **元素裁剪改为 CDP screencast 单帧采集**（非破坏性，DevTools 预览同机制）：
   - `screenshotRegion` 重写：经 `page.context().newCDPSession(page)` 发 `Page.startScreencast({format:'png', maxWidth:1920, maxHeight:1080})` → 收到首帧 `Page.screencastFrame`（记得回 `Page.screencastFrameAck`）→ `Page.stopScreencast` → 在 Node 侧按 rect+scroll+dpr 从整帧裁剪（裁剪可用现成 PNG 解码依赖或 sharp？**不引新依赖**：若裁剪实现成本高，可先落整帧为 crop 文件并把 rect 信息留在 CropSchema.ref 同目录的 sidecar json——证据查看器按 sidecar 裁剪显示；二选一由执行会话定，倾向 sidecar 方案零依赖）。
   - screencast 不可用（失败/超时 1.5s）→ 回退现有 `page.screenshot`（保留代码路径）。
   - screencast 会话按动作短开短关，避免常驻。
3. **rrweb 快照瘦身**：`src/rrweb-inject.ts` record options 增加 `slimDOMOptions`（去注释/空文本节点等，`{script:false}` 以外的保守组合）与 `inlineStylesheet` 保持默认；如 rrweb 版本支持 `collectFonts:false`（默认已 false）。目标：降低导航期 CPU 尖峰。
4. **诊断开关**（给用户真机 bisect 用，保留）：环境变量 `FLOWLINK_DISABLE_RECORDER_SHOTS=1` 时元素裁剪也跳过（crop 缺省，证据查看器显示无截图）。若用户设该变量后闪烁完全消失，进一步证据指向截图链。
5. 可选增强（低优先）：录制中每动作的 `describeElement`/ariaSnapshot（CDP DOM 快照）也发生在动作路径上——保持不动，除非 D1 验证后仍有闪烁再做第二轮 bisect。

验收：录制一段含多次点击/输入/导航的流程，观察无闪烁；证据查看器仍有元素截图；Record 页 rrweb 回放正常、截图墙为空时不占位。

## 第 2 项：Test 偶发无法加载页面

### 根因（高概率竞态，代码级确认）

`playback:run`（`src/main.ts`）先 `resetBrowserTabs(startUrl)` —— 其中 `void browserView.webContents.loadURL(startUrl)` **fire-and-forget**（`src/main.ts:357` 附近）；随后执行器在**首个可执行步骤是 navigate 时跳过 startUrl 导航**（`engine/executor/src/run.ts:531-537`），由该 navigate 步骤自己 `goto`。两条导航在途上竞争：Electron loadURL 与 CDP Page.navigate 交错 → 间歇性 `net::ERR_ABORTED`/加载被取消 → 分类为 NAVIGATION_FAILED。`playback:runPrefix` 同样路径。

### 修改方案（D1 实施）

1. `resetBrowserTabs(initialUrl, opts?: { navigate?: boolean; awaitLoadMs?: number })`：
   - **首步是 navigate 的流程**：playback:run/runPrefix 加载 flow 后用 `flattenSteps` 判定首步类型，传 `navigate:false`——不再触发 loadURL，唯一导航由执行器首步 goto 完成，竞态消除（空白页期间视图保持现状即可）。
   - **首步不是 navigate**：`navigate:true` 且 `awaitLoadMs`（默认 10s）内等待 loadURL 完成/超时（监听 did-stop-loading 或 Promise.race），超时不失败（执行器 startUrl goto 已有 2 次重试兜底）。
2. navigate 步骤动作增加 1 次重试（对齐 startUrl 的 2 次语义，含 `net::ERR_ABORTED` 视为可重试）：定位 `runAction` 的 navigate 分支（`engine/executor/src/actions.ts`）。
3. `playback:aiContinue` 路径不涉及 reset，不动。

验收：对同一流程连跑 10 次 Test，不再出现间歇性「无法加载页面」（真机验证项）。

## 第 3 项：Test 每步后默认等待（等页面稳定/变化）

### 现状

步骤间固定 `stepDelayMs: 350`（main.ts 两处 playOnPage 调用）；`settle` 仅在步骤**显式配置** `settle` 字段时在**步前**生效（run.ts:769-780，`waitForSettle` 在 `engine/executor/src/settle.ts`）。快速 SPA 页面上 350ms 常不够 → 下一步元素查找失败。

### 修改方案（D1 实施）

1. 执行器主循环在**动作类步骤成功后**默认执行「轻量步后沉降」：`waitForSettle(page, { domQuietMs: 350, maxMs: 2500 }, log)`（复用 settle.ts；不设 networkIdle——等 DOM 静默即可，避免大页面网络长尾）。
   - 适用 kind：click/input/select/key/hover/drag/upload；不适用：assert/condition/wait/navigate/组间。
   - expect 校验之前的时序不受影响（settle 在 expect 前做即可，等效「等页面变化完成再校验」）。
2. 开关：环境变量 `FLOWLINK_DISABLE_POST_STEP_SETTLE=1` 关闭；`stepDelayMs` 保持 350。
3. 日志：settle 实际耗时计入 stepLog（`post-settle: Xms`），便于真机调参。

验收：原「特别容易执行失败」的快速页面流程，Test 通过率明显上升（真机验证项）。

## 第 4 项：Test 失败后单步 AI 接管，成功后回到程序执行（D2 实施）

### 设计

目标：把「接管剩余全部步骤」改为默认「只 AI 执行失败的那一步，成功后从下一步恢复程序回放」，大幅降 token 与耗时；全量接管保留为显式选项。

1. **ai-takeover.ts**：`StartAiTakeoverOptions` 增加 `mode: 'remaining' | 'single'`；single 时 projections 只含 `fromStepIndex` 一步；沿用 mark_step_done 双门槛与重试；单步两败不触发 free-run（free-run 属于全量模式的降级）。`AiTakeoverDoneEvent` 带 `mode`。
2. **执行器**：`playOnPage` 增加 `startCursor`（扁平下标）：`flatCursor` 从 startCursor 起步，之前的步骤逐个报 `skip`（note: `bypassed (resumed after AI step)`），不执行、不计 pass/fail；路由类 condition 在被跳过段内不评估（线性直进，接受该近似并在 run log 注明）。
3. **main.ts**：`playback:run` 接受可选 `resumeFromStepIndex`（校验非负整数，钳制到扁平长度），转 `startCursor`；`playback:aiContinue` 接受 `mode`。
4. **renderer/bridge.js 编排**（核心状态机）：
   - 新函数 `runAiAssistedTest(item)`：`playback:run`（正常）→ 结果若在某步 i 失败（playback:done ok:false 或步骤 fail）→ 对 i 调 `playback:aiContinue({fromStepIndex:i, mode:'single'})` → aiDone ok → `playback:run({resumeFromStepIndex:i+1})` → 若又在 j 失败 → 重复。
   - 界限：单轮 Test 内 AI 单步介入 **最多 6 次**；同一单步 AI 两败 → 回退一次全量接管（现有 remaining 模式，内部自带 free-run 降级）。
   - 每次单步 aiStep 成功 → 对应步骤 UI 标 AI 徽标（现有 playback:aiStep 处理复用）；resume 的 skip 结果按现有 skip 语义展示（Pending/Skipped 规约见 memory feedback）。
   - quickbar：「AI Continue」默认走单步模式；下拉/次要按钮「AI 接管全部剩余」保留旧路径。Test 自动执行失败后的 AI 接管入口（现有 quickHost #aiContinueTest）与自动 repair（aiDone→aiRepairFlowAfterTakeover）链路不变，只需在 assisted 循环全部结束后触发一次。
   - Test 结果合并：resume 运行的步骤结果并入同一 item.testResults（索引天然对齐，flatten 唯一实现）。
5. lastRun：assisted 循环结束后按最终结果写（现有 playback:done/aiDone 路径已覆盖，注意别被中间 resume 覆盖为失败——resume 的 playback:done 会写 lastRun，若 assisted 循环还在进行需抑制中间写入，循环结束后由 bridge 统一写）。

验收：构造第 3 步必败的流程 → AI Continue：agent 只执行第 3 步（日志/消息可见仅 1 步），成功后第 4 步起程序执行；token 消耗对比旧全量模式显著下降（真机验证项）。

## 第 5 项：Instruction 步骤菜单（暂只有 Delete）（E 实施）

- 现状：`renderer/index.html` `instructionStepTemplate` 已有 `.instruction-step-menu` 按钮（~1758-1769）但无任何处理器（不可点）。
- 实施：点击打开小弹出菜单（结构上预留多菜单项），本期仅一项 **Delete**：
  - 直接删除该步骤（不加确认，快操作），走 processFlow + `flow:updateSteps` 持久化（B 任务已建的编辑管道），成功后重渲染 + toast 提示「已删除步骤 N-NNN」；失败内联报错回滚。
  - 边界：删除后所在 group 变空 → 连同空组一起删，并清理指向该组的 condition true/false 引用（复用 `deleteProcessGroup` 的清理逻辑，app.js:6040 附近）；顶层只剩一个组时不允许删到 0 步（契约要求 steps 非空）——按 `flow:updateSteps` 校验报错兜底。
- 菜单开合交互参照 type-picker 弹层的关闭处理（closeStepTypePickers 同款全局关闭）。

## 第 6 项：润色入口移到 AI 面板预设（E 实施）

- 移除 Instruction 头部 `.instruction-polish` 按钮（`renderer/index.html` ~1107-1112）；保留 diff 对话框模板 `instructionPolishTemplate` 与 B 任务已实现的润色管线。
- `renderer/app.js` `REFINE_PRESETS`（~4955-4961）追加一项 **"Optimize step descriptions (labels only)"**：
  - `submitRefineOptions` 路由规则：**仅勾选该预设且无其它预设/自由文本**时 → 走润色管线（label-only 生成 + diff 对话框 + 写回当前录制）；其它组合 → 维持现有全量 refine 管线，该预设文本作为 instruction 一部分（生成提示词本就要求业务语言 label，语义兼容）。
  - 润色管线入口复用 B 任务实现（搜 `instruction-polish` / polish 相关函数名定位），仅删除头部按钮触发点、增加预设触发点。
- AI 面板预设区的渲染（`quickHost.querySelector("[data-refine-presets]")` ~5195）自动包含新预设，无需改渲染代码。

## 第 7 项：rrweb 回放始终黑屏（根因已实锤，D1 实施）

### 根因（本地已复现验证，非猜测）

用真实录制数据（`%APPDATA%/flowlink/.../recording-1794905017210`）+ `dist/renderer-vendor.js`
搭了最小回放 harness（`scratch-rrweb-debug/`，node 静态服务 + 页面）复现：
事件数据完全正常（Meta+FullSnapshot+增量，iframe 内成功渲染出 34 个 body 子节点），
但页面里 **0 条 `.replayer-*` CSS 规则**——rrweb 2.2.2 的 Replayer 基础样式在
`rrweb/dist/style.css`（包有 `./dist/style.css` export），vendor 打包只引了 JS 没引 CSS。
后果：`.replayer-mouse-tail` canvas 按文档流静态排版占 832px 高，把回放 iframe 挤到
容器可视区之外 → 舞台只剩深色背景 = 黑屏。

### 修改方案（D1 实施）

1. `src/renderer-vendor.ts`：`import 'rrweb/dist/style.css'`；build.mjs 的 vendor 构建
   会产出 `dist/renderer-vendor.css`，`renderer/index.html` 在 vendor.js 之前加
   `<link rel="stylesheet" href="../dist/renderer-vendor.css">`。
   （备选：build.mjs 给该 entry 配 `loader: {'.css':'text'}` 后在 vendor JS 里注入
   `<style>`，单文件自包含；两案选一，倾向 link 方案，改动最小。）
2. 防御性补充（app.css 的 rrweb 舞台段）：`.rrweb-tab-view .replayer-wrapper{position:relative}`
   `.replayer-wrapper>iframe{position:absolute;top:0;left:0}` —— 即使 CSS 再缺失也只是
   布局退化而非黑屏。
3. 验证：真机 Record 页回放该段录制应显示博世主页画面；也可用 harness
   （`scratch-rrweb-debug/harness.html`，重新拷贝构建后的 vendor.js + 任一 jsonl 即可）
   快速回归。修完可删除 scratch 目录。

## 会话划分与验收汇总

| 会话 | 模型 | 范围 | 文件 |
|---|---|---|---|
| D1 | Opus | 第 1、2、3、7 项 | engine/recorder/*、engine/executor/*、src/rrweb-inject.ts、src/renderer-vendor.ts、src/main.ts、renderer/index.html（css link）、renderer/app.css、renderer/bridge.js（截图墙去占位）、renderer/app.js（fillRecordPanel 空态） |
| D2 | Opus | 第 4 项 | src/ai-takeover.ts、engine/executor/src/run.ts、src/main.ts、renderer/bridge.js、renderer/app.js（quickbar）、renderer/index.html |
| E | Sonnet | 第 5-6 项 | renderer/index.html、renderer/app.js、renderer/app.css |

串行执行（D1→D2→E，同检出文件重叠）。每个会话结束跑 build+tsc 并更新 CHANGELOG。
真机验证清单：见各节「验收」+ Record 页新录制无截图墙、Instruction 菜单 Delete、AI 面板新预设路径。
