# FlowLink 全场景响应文档（操作 → 调用链 → 内部执行 → 故障定位）

> 本文按**用户操作**组织：每个操作给出「触发入口 → 渲染层函数 → IPC 通道 → 主进程处理器 → 引擎方法」的完整调用链，以及结果不符合预期时应该排查的位置。
> 组件视角的架构说明见 `docs/architecture.md` 与 `docs/technical-architecture.md`；本文是操作视角的补充，粒度到函数与 IPC 通道。
>
> 标注约定：`src/main.ts:1362` 表示文件与行号（写作时基准，重构后以函数名检索为准）。

---

## 目录

1. [三分钟架构总览](#1-三分钟架构总览)
2. [应用启动链路](#2-应用启动链路)
3. [场景 A：任务列表与 Profile](#3-场景-a任务列表与-profile)
4. [场景 B：内嵌浏览器](#4-场景-b内嵌浏览器)
5. [场景 C：录制](#5-场景-c录制)
6. [场景 D：分析工作区（Process / Instruction / Reference / Record / Metric）](#6-场景-d分析工作区)
7. [场景 E：测试回放（Test）与 AI 接管](#7-场景-e测试回放与-ai-接管)
8. [场景 F：AI 面板](#8-场景-fai-面板)
9. [场景 G：回放中的人工确认（userOperation / manual 步骤）](#9-场景-g回放中的人工确认)
10. [持久化数据全景](#10-持久化数据全景)
11. [故障定位手册](#11-故障定位手册)
12. [错误码速查与调试入口](#12-错误码速查与调试入口)

---

## 1. 三分钟架构总览

### 1.1 运行时结构

```
┌────────────────────────── Electron 主窗口 ──────────────────────────┐
│                                                                     │
│  渲染进程（Chromium，加载 renderer/index.html）                       │
│    ├─ renderer/app.js          UI 控制器 + 会话状态（演示模式原生版） │
│    ├─ renderer/bridge.js       ★ Electron 模式覆盖层（IPC 替换 mock）│
│    ├─ renderer/flow-graph.js   window.FlowGraph：展平/图模型/dagre   │
│    └─ dist/renderer-vendor.js  window.__flowlinkDagre（vendored）    │
│                                                                     │
│  preload（contextBridge，src/preload.ts）                            │
│    └─ window.flowlink.{tasks,processLandscape,recording,playback,   │
│                        pi,flow,browser}.xxx + on(channel) 白名单    │
│                                                                     │
│  ┌── 原生浏览器（WebContentsView，非 iframe！）──────────────────┐   │
│  │  browserViews: Map<tabId, WebContentsView>，只显示活动的那个  │   │
│  └───────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
        │ IPC（ipcRenderer.invoke ↔ ipcMain.handle，事件反向 send）
┌───────┴─────────────────────────────────────────────────────────────┐
│ 主进程（src/main.ts）                                               │
│   ├─ TaskStore（src/store.ts）        tasks.json 原子读写            │
│   ├─ EngineBridge（src/engine-bridge.ts） Playwright connectOverCDP  │
│   │    ※ Electron 以 --remote-debugging-port=0 启动，端口写在        │
│   │      userData/DevToolsActivePort，pageFor() 用 window 标记匹配   │
│   ├─ Pi agent（src/pi-agent.ts + pi-agent-worker.ts，worker 线程）   │
│   ├─ AI 细化（src/ai-refine.ts，无 Electron 依赖的纯管线）           │
│   └─ AI 接管（src/ai-takeover.ts，@browser_use/pi 附着同一 CDP）     │
└───────┬─────────────────────────────────────────────────────────────┘
        │ Playwright CDP（引擎只拿 Page 对象）
┌───────┴─────────────────────────────────────────────────────────────┐
│ 引擎（engine/，纯 TS，无 Electron 依赖）                             │
│   ├─ recorder  事件采集→合流→成步→落 Flow（record.ts 编排）           │
│   ├─ executor  回放内核：resolve→act→verify（run.ts 编排）           │
│   ├─ resolver  元素解析阶梯 L1 语义→L2 指纹→L4 AI（默认不注入）       │
│   └─ schema    Zod Flow IR + 迁移 + 原子写（io.ts / schema.ts）      │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 必须先理解的三个机制

1. **app.js 是"演示模式"，bridge.js 是"Electron 模式"。**
   [app.js](../renderer/app.js) 自带一套 iframe 模拟浏览器 + postMessage 捕获的实现；在 Electron 里运行时 [bridge.js](../renderer/bridge.js)（IIFE，在 app.js 之后加载）会**直接覆盖**一批顶层函数：`saveProfile`、`validatedRecordingURL`、`navigateRecordingBrowser`、`loadRecordingFrame`（→ no-op）、`moveRecordingHistory`、`mountBrowserSurface`、`confirmWorkspaceAction`、`startBrowserRecording`、`finishBrowserRecording`、`captureBrowserAction`、`beginGroupRecording`、`resetTestBrowser`、`resetRecordingForNewSession`、`addBrowserPage`、`switchBrowserPage`、`closeBrowserPage`、`startRecordingMedia`、`stopRecordingMedia`、`requestRecordingSnapshot`（→ no-op）、`flowRowActionDisabled`、`closeDrawer`。
   **排障第一课：看到 app.js 里某函数写的是 iframe 逻辑，先确认 bridge.js 是否覆盖了它。** 会话状态（`flowData`、`recordingSessions`、`profileDrafts`）两边共享，不是两套。

2. **原生浏览器视图的位置由渲染层"上报"。**
   渲染层的 `#browserFrames` 只是个占位 div；bridge.js 的 `reportBrowserBounds()`（`renderer/bridge.js:371`）把它的屏幕矩形经 `browser:setBounds` 发给主进程，主进程把 WebContentsView 移动/缩放到该矩形（16ms 合并节流，`src/main.ts:880`）。布局变化靠 ResizeObserver + 窗口 resize + 渲染后 RAF 兜底重报（`renderer/bridge.js:1931`）。矩形有**几何去重缓存**（`lastBrowserBoundsKey`），隐藏时必须清缓存否则同尺寸恢复不上报（`hideNativeBrowser`，`renderer/bridge.js:365`）。

3. **录制/回放事件全部是"主进程 push、渲染层订阅"。**
   preload `on()` 只放行 15 个通道（`src/preload.ts:117`）：`recording:step/done/error/captureFrame`、`playback:step/done/error/userOperation/aiStep/aiDone`、`browser:urlChanged/loading/error/tabOpened`、`ai:autoRefine`。所有订阅集中在 bridge.js 第 7 节（`renderer/bridge.js:1505` 起）。

### 1.3 目录速查

| 路径 | 职责 |
|---|---|
| `src/main.ts` | 主进程：窗口/浏览器视图/IPC/录制回放会话状态机 |
| `src/preload.ts` | `window.flowlink` 窄 API |
| `src/store.ts` | `TaskStore`：tasks.json 持久化 |
| `src/engine-bridge.ts` | WebContentsView ↔ Playwright Page 映射（`pageFor`） |
| `src/pi-agent.ts` / `pi-agent-worker.ts` | Pi SDK（worker 线程）：advice / 生成管线 / 预热 |
| `src/ai-refine.ts` | 细化生成管线：投影 → Pi → $ref 再水化 → parseFlow 校验 |
| `src/ai-takeover.ts` | browser-use 接管：失败后续跑剩余步骤 |
| `src/prompts.ts` | `config/prompts.json` 模板加载校验（`{{key}}` 填充） |
| `renderer/app.js` | UI 控制器、会话/草稿状态、各结果面板渲染 |
| `renderer/bridge.js` | Electron 覆盖层 + 全部 IPC 事件订阅 |
| `renderer/flow-graph.js` | `FlowGraph.flattenFlowSteps / buildGraph / layoutGraph` |
| `engine/recorder/src/` | `record.ts`（编排）、`coalesce.ts`（事件合流）、`classify.ts`（导航分类）、`element.ts`（候选/指纹）、`capture-client.ts`（页面采集）、`plan.ts`（规划纯函数）、`expect.ts`（期望推断） |
| `engine/executor/src/` | `run.ts`（执行内核）、`actions.ts`（动作）、`verify.ts`（校验）、`settle.ts`（沉降）、`tabs.ts`（PageManager）、`dialogs.ts` / `downloads.ts` / `artifacts.ts` / `errors.ts`（错误码） |
| `engine/resolver/src/` | `index.ts:resolve`、`l1.ts` / `fingerprint.ts` / `frames.ts` |
| `engine/schema/src/` | `schema.ts`（Zod IR）、`io.ts`（parse/迁移/原子写） |
| `engine/recorder/capture/capture.js` | 注入页面的采集脚本（监听 DOM 事件，经 `__rrEmit` binding 上报） |

---

## 2. 应用启动链路

**命令行**：`npm start`（= `node scripts/start.mjs`）→ 先跑 `node build.mjs`（esbuild 打包 src/*.ts、engine、vendor dagre）→ 再启动 `node_modules/electron/cli.js .`。`--dev` 会加 `--inspect=9229`；`--pi-system-proxy` / `--pi-proxy=<URL>` 选择 Pi 代理模式（`src/pi-agent.ts:233 getPiProxyOptions`）。

**主进程启动**（`app.whenReady()`，`src/main.ts:504`）：

1. 建 `userData/flowlink/artifacts/` 与 `userData/flowlink/flows/` 目录。
2. `new TaskStore(userData/flowlink/tasks.json)`（懒加载，首次读取才解析 JSON）。
3. `registerIpc()`（`src/main.ts:847`）注册全部 `ipcMain.handle`。
4. `createWindow()`（`src/main.ts:543`）：BrowserWindow（preload=dist/preload.cjs，contextIsolation 开、nodeIntegration 关）＋首个 `WebContentsView`（tabId 固定 `'browser'`，初始 1×1 且隐藏）；`loadFile(renderer/index.html)` → `show()`；1.5s 后 `prewarmPi()`（失败静默）；后台 `loadURL('https://bosch.com.cn')`（不等加载完成，不阻塞窗口）。
5. `waitForCdpPort(userData)`（`src/main.ts:490`）：轮询 `DevToolsActivePort` 文件最多 8s → `new EngineBridge(userData)` → 后台预热 `engine.pageFor('browser', …)`。
   **失败后果**：EngineBridge 没建成时 `engine` 为 undefined，`recording:start` / `playback:run` 会直接抛「引擎未就绪（CDP 连接失败）」。

**渲染进程启动**：index.html 依次加载 `dist/renderer-vendor.js`（dagre，缺失时 Process 图报错不白屏）→ `app.js` → `bridge.js`。bridge.js 立即：

- `F.processLandscape.load()` → 主进程读 `process_landscape/full.json`（`processLandscape:load`）→ `setProcessLandscape(tree)`；失败则四个 Service Level 下拉禁用并显示错误。
- `loadTasksFromStore()`（`renderer/bridge.js:55`）→ `F.tasks.list()` → `tasks:list` → `TaskStore.listMetadata()`（只含 `recordingCount`，不含录制详情）→ 填充 `flowData` → `render()`。

**详情懒加载**：打开任务抽屉才调 `window.loadTaskDetails(code)`（`renderer/bridge.js:81`）→ `tasks:getRecordings` 拿 `RecordingMeta[]` → 逐条 `flow:load` → `FlowGraph.flattenFlowSteps` 建 `item.testFlowSteps/testFlowIndexById/steps/testResults`。

---

## 3. 场景 A：任务列表与 Profile

### A1. 新建 Taskflow（点 `#create`）

```
app.js openDrawer(null)（renderer/app.js:380）
  → currentFlow=null；清掉上个未保存会话的临时录制状态
  → initializeDrawerRecording(code)（renderer/app.js:2040）
      → activeFlowKey = nextTaskflowCode()（TASKFLOW-00N，N=现有最大+1）
      → recordingSession()（renderer/app.js:1990，按需建会话状态）
  → $('drawer').showModal()
```

新 Taskflow 在**保存 Profile 前**只是一个内存中的 taskCode（`activeFlowKey`）；录制可以先发生（主进程 `addRecording` 会自动补一个壳任务，`src/store.ts:149`），但关闭抽屉时若仍未保存过 Profile，bridge 的 `closeDrawer` 会把整个临时任务连同录制一起删掉（见 A6）。

### A2. 打开已有任务（列表行 `#code` 链接 / Edit 按钮）

```
bridge.js 包裹的 $('flowRows').onclick（renderer/bridge.js:1234）
  → app.js openDrawer(code)
      → window.loadTaskDetails(code)（renderer/bridge.js:81，异步）
          → F.tasks.getRecordings → tasks:getRecordings（src/main.ts:867）
          → 逐录制 F.flow.load → flow:load → loadFlow（engine/schema/src/io.ts:66）
          → state.items / testFlowSteps 就绪后 renderRecordingWorkspace()
```

### A3. 保存 Profile（`#profileSave`）

```
bridge.js saveProfile 覆盖版（renderer/bridge.js:158）
  → validateProfileServices()（必填项 + 四级 Service Level 全选校验）
  → confirmWorkspaceAction('Save this flow profile?')（确认框前会隐藏原生浏览器）
  → 版本号推进 nextTaskVersion（vX.Y.Z → patch+1；首次归一 v1.0.0）
  → F.tasks.saveProfile(patch) → tasks:saveProfile（src/main.ts:857）
      → TaskStore.upsertProfile（src/store.ts:129）→ persist()（tmp+rename 原子写）
  → IPC 成功后才把 patch 并入 flowData（新任务此时才成为正式列表行）
  → _origCloseDrawer()（存草稿、关抽屉、恢复焦点）
```

版本状态切换（`#versionManagementRows` 的 select）走 `commitVersionStatus`（`renderer/app.js:306`），**只改内存**；要持久化必须再点 Save。

### A4. 筛选 / 搜索列表（`#query` 表单、`#reset`、状态页签、Category）

纯渲染层：`appliedSearch/appliedName/appliedVersion/appliedCategory/activeStatus` → `render()`（`renderer/app.js:318`）。Category 选项 = 演示种子（"采购/信息检索"）∪ 已保存任务出现过的类别。无 IPC。

### A5. 列表行 Run（`data-action="run"`）

```
bridge.js runFlow(code)（renderer/bridge.js:1465）
  → openDrawer(code) + showDrawerTab('Design') + loadTaskDetails(code)
  → 取该任务最后一条录制 → referenceVariablesForReplay(item)（拉变量，见 D3）
  → F.playback.run → playback:run（同 E2 主进程链路）
```

Run 按钮可用条件（`flowRowActionDisabled` 覆盖版，`renderer/bridge.js:1226`）：任务 enabled 且有录制。

### A6. 列表行 Delete（`data-action="delete"`）与关闭抽屉

```
deleteFlow(code)（renderer/bridge.js:1485）
  → confirm → F.tasks.remove → tasks:delete（src/main.ts:860）
      → 对每条录制 removeRecordingFiles（src/main.ts:156，带三重删除守卫：
        artifacts 必须在根下、文件名必须匹配生成式、capture 目录必须 recording- 前缀）
      → TaskStore.remove
  → 本地 flowData / recordingSessions / profileDrafts 清理 → render()
```

关闭抽屉（bridge `closeDrawer`，`renderer/bridge.js:1881`）：录制中 → 确认并 `finishBrowserRecording({skipEmptyConfirmation:true})`；然后确认 'Close this flow?'；**若 `!currentFlow && activeFlowKey`（未保存的新 Taskflow）→ `F.tasks.remove(activeFlowKey)` 连同其草稿期录制作清理**；最后 `hideNativeBrowser()` 拆观察器再走原 closeDrawer。

---

## 4. 场景 B：内嵌浏览器

### B1. 浏览器为什么显示在那里（bounds 上报）

```
bridge.js mountBrowserSurface（覆盖版，renderer/bridge.js:304）
  → 不建 iframe；绑地址栏/导航按钮；reportBrowserBounds()
      → 读 #browserFrames.getBoundingClientRect()
      → 几何去重（lastBrowserBoundsKey）→ F.browser.setBounds(rect)
          → browser:setBounds（src/main.ts:880）
              → browserBounds 更新 + 16ms 定时器合并
              → 所有 view.setBounds(browserBounds) + syncBrowserVisibility()
  → ResizeObserver(#browserFrames) 持续上报；window resize 再补报
  → renderAIPanel/renderSummaryWorkspace/renderRecordingWorkspace 被包装：
     每次渲染后 RAF + 350ms 双保险重报（renderer/bridge.js:1931）
```

主进程可见性唯一判断（`syncBrowserVisibility`，`src/main.ts:211`）：`view === 当前活动页 && browserSurfaceVisible && bounds > 1×1`。**loading 状态不参与**，导航不会闪视图。

### B2. 地址栏导航 / 后退 / 前进 / 刷新

```
Enter（#recordingAddress onkeydown）→ openRecordingURL（renderer/app.js:2508）
  → validatedRecordingURL（覆盖版，仅 http/https；localhost 补 http://）
  → navigateRecordingBrowser（覆盖版，renderer/bridge.js:241）
      ① 乐观更新 page.url/draftURL/history
      ② F.recording.navigate(next, page.nativeId)
           → recording:navigate（src/main.ts:1137）
               → normalizeHttpUrl（协议校验/补全）
               → 录制中：hostEvents.push({action:'userNavigateRequested',…})
                  ※ 这是"地址栏导航"能成为 navigate 步骤的证据来源
               → view.webContents.loadURL(normalized) → 返回实际 URL
      ③ 失败：回滚 page.url，地址栏 setCustomValidity
后退/前进/刷新 → F.recording.goBack/goForward/reload → recording:goBack/goForward/reload
  （src/main.ts:1145-1165，录制中分别记 historyBackRequested/historyForwardRequested/reloadRequested）
```

页面自身导航 → 主进程 `did-navigate`/`did-navigate-in-page` 转发 `browser:urlChanged` → bridge 处理器（`renderer/bridge.js:1505`）把 URL 写回对应页对象并刷新地址栏。加载失败（主 frame，非 -3）→ `browser:error` → 地址栏校验提示。

### B3. 新建 / 切换 / 关闭标签页

```
+ 按钮（#newBrowserPage）→ bridge addBrowserPage（renderer/bridge.js:935）
  ① 先把占位页入 state.browserTabs（保证异步事件能路由）
  ② F.browser.createTab → browser:createTab（src/main.ts:925）
       → createBrowserTab(tabId,'about:blank')（新 WebContentsView + registerBrowserTab）
       → 录制/回放中：engine.pageFor 附着，塞进 recordingAdditionalPages
  ③ page.nativeId = 返回的 tabId → F.browser.switchTab(nativeId)
  ④ 失败回滚占位页

点击标签 → switchBrowserPage（覆盖版，renderer/bridge.js:986）
  → F.browser.switchTab → browser:switchTab（src/main.ts:939）
      → 换 browserView/activeBrowserTabId；录制中记 hostEvents tabActivated
  → captureBrowserAction({type:'tab-switch'})（仅作渲染层兜底计数）

× 按钮 → closeBrowserPage（覆盖版，renderer/bridge.js:997）
  → F.browser.closeTab → browser:closeTab（src/main.ts:953）
      → 守卫：主标签 'browser' 不可关；engine.forget(tabId)；录制中记 tabClosed
```

### B4. 页面弹窗（window.open / target=_blank）

主进程 `setWindowOpenHandler`（`src/main.ts:594` 与 `registerBrowserTab` 内 `src/main.ts:250`）deny 系统弹窗、改为 `createBrowserTab` → 广播 `browser:tabOpened` → bridge 处理器（`renderer/bridge.js:1522`）按 `nativeId` 去重建页对象，`active===true` 时切过去。录制中：主进程同时后台 `engine.pageFor` 附着新页，引擎侧 `context.on('page')` 会产出 `openTab` 步骤（见 C3）。

### B5. 浏览器重启（Test / 分组重录前的复位）

```
F.browser.restart(startUrl) → browser:restart（src/main.ts:902）
  ① 若有录制会话 → stopRecordingSession({discard:true})（丢弃式收尾，先等完）
  ② URL 协议白名单校验（非法回退 bosch.com.cn）
  ③ resetBrowserTabs(startUrl)（src/main.ts:327）
       - 等待在途 recStopPromise / playPromise
       - 关闭全部非主标签页并 engine.forget；主视图保留（同页不重载，导航后台进行）
  ④ engine.forgetAll()（清全部 Page 缓存）→ 后台重新预热 pageFor
```

---

## 5. 场景 C：录制

### C1. 开始录制（Import 菜单 → "Record browser"，或分组重录到达边界后自动）

```
UI：#prepareRecording 菜单 → runImportAction('browser')（renderer/app.js:2347）
  → prepareRecording（renderer/app.js:2481）
      → resetRecordingForNewSession（覆盖版，renderer/bridge.js:891）
          （关多余标签页、主标签切回 bosch.com.cn、状态复位为 ready）
      → 草稿地址有效则先 navigateRecordingBrowser
  → startBrowserRecording（覆盖版，renderer/bridge.js:421）
      → 建 state.pending；stage='recording'；updateBrowserChrome
      → startRecordingMedia（覆盖版，renderer/bridge.js:1016）
          （canvas 960×540 + captureStream(10) + MediaRecorder，等待 IPC 推帧作画）
      → F.recording.start({taskCode, startUrl, preservePage?})
          → recording:start（src/main.ts:1169）
```

主进程 `recording:start` 关键步骤（每步都有 perf 打点）：

1. 守卫：`recStartPromise/recStopPromise/recPromise` 任一在 → "已有录制正在进行"；`engine` 空 → "引擎未就绪"。
2. `recOutPath = flows/<Date.now()>-<taskCode>.json`；`recController = new AbortController()`。
3. **非** preservePage（普通录制）→ `resetBrowserTabs(startUrl)`；preservePage（分组重录）跳过，保住前缀回放到达的页面状态。
4. `engine.pageFor(activeBrowserTabId, browserView.webContents)`（`withAbort` 包裹，Stop 可打断）→ 依次附着其余标签页（顺序 = browserViews 插入序，回放映射靠它）。
5. `startRecordingCapture('recording-<ts>')`（`src/main.ts:451`）：建 `artifacts/recording-<ts>/record/video/`，**每 800ms** `captureRecordingFrame`（`src/main.ts:422`）：`webContents.capturePage()` → 写 `frame-NNNN.png` → 推 `recording:captureFrame {dataUrl,index,tabId,url}`。
6. `recPromise = recordOnPage({page, pages, tabIds, keepRaw:true, startUrl, skipNavigate:true, outPath, artifactsRoot, hostEvents: recordingHostEvents, stopSignal, title, onStep})`（后台跑；onStep → 推 `recording:step`）。
7. 返回 `{ok:true}`。启动失败 → 渲染层把 stage 回滚 'ready' 并重绘（bridge 覆盖版 catch）。

### C2. 页面操作如何变成 Flow 步骤（录制核心管线）

**采集层（页面内）**：`installCaptureOnPage`（`engine/recorder/src/capture-client.ts:86`）把 `engine/recorder/capture/capture.js` 注入页面，DOM 事件经 `page.exposeBinding('__rrEmit')` 回到 Node 侧 `onEmit`（`engine/recorder/src/record.ts:376`）→ `enqueueRawEvent`（打 frameIndex/pageIndex/tabId/systemId，进 `pending` 队列与 `allEvents` 证据副本，上限 10 万条）。

**合流层（每 100ms tick，静默 500ms 冲洗）**：`flush`（`record.ts:1180`）→ `processBatch`（`record.ts:1228`）：

1. 分流：`AUTO_NAVIGATION_TYPES`（`classify.ts:35`：`sso_redirect/login_redirect/auto_redirect`）抽出，不进普通合流；host 事件 `userNavigateRequested` 对应的导航事件也单独成动作。
2. `coalesceEvents(pageEvents)`（`coalesce.ts:56`）把原始事件合流为 `CoalescedAction`（click/input/select/key/hover/scroll/drag…；`dragStart+drop` 同页 5s 内配对成 drag）。
3. `synthesizeOptionalNavigations(autoNavigations)`（`plan.ts:248`）把认证跳转合成 `isOptional` navigate 动作。
4. hover 意义过滤（`isMeaningfulHover`，`plan.ts:177`；无意义悬停挂起最多 2.5s 等后续点击）。
5. `withTabSwitches` + `insertDialogs`（`plan.ts:45/119`）补 `switchTab`/`openTab`/`dialog` 计划项。
6. 对每个动作：`settleFrameStability`（连续 2 帧布局不变）+ `waitForSilence`（300ms 事件静默，上限 5s）→ `buildStep(action)`（`record.ts:890`）：

   - **navigate** → URL 提参为 `url_N` 变量；机器跳转加 `isOptional:true`。
   - **click** → 命中 `<input type=file>` 转 upload（`file_N` 变量）；closed shadow 目标带 `position`。
   - **input** → 密码框/掩码 → `{{password}}` secret 变量；普通 → `input_N` 变量（默认值=录制值）。
   - **select** → 单选提参 `select_N`；多选保持内联数组。
   - 元素证据：`buildRefFor`（`record.ts:705`）= `locateByUid` 找回元素 → `readFactsByUid` 刷新事实 → `describeElement`（ariaSnapshot 取 role/name）→ `backfillRoleName`（aria 缺失时 tag→隐式 role、文本→name）→ `deriveCandidates`（`element.ts:280`，评分序生成候选）→ `validateCandidates`（`capture-client.ts:397`，"可见元素中唯一命中"规则）→ 元素裁剪截图 → `buildFramePath`（iframe 链 anchor+urlPattern）→ `buildElementRef`。
   - 全部候选只剩结构定位 → `markWeakTargetReview` 写 `reviewRequired`（录制当场标记脆弱步骤）。
7. expect 推断：签名采样器每 120ms `snapshotPage`（最多前 4 个标签页，上限 600 样本）→ `takeExpect(before,after)`（`record.ts:1033`：url 变化 → urlChange；新出现元素 → elementVisible 等）。drag/可选导航不推断。
8. `pushStep`（`record.ts:260`）：打 tabId/systemId/systemName/pageUrl/sourceEventIds → `steps.push` → `opts.onStep(step)` → 主进程推 `recording:step` → bridge 只把它当**轻量计数**塞进 `state.pending.actions`（`renderer/bridge.js:1604`），真正的步骤数据以落盘 Flow 为准。

**旁路事件**：`page.on('dialog')` 立即 accept（否则页面卡死）并记 `dialogs[]`；`page.on('download')` 记 `downloads[]`；`context.on('page')` 新标签页 → `recordOpenedTab`（host 已记 tabCreated 则不重复）+ `installCaptureOnPageWithRetry`（5 次有界重试）；页关闭/崩溃 → `detachPage`（崩溃页跳过成步，不终止录制；index>0 的关闭补 `closeTab` 步骤）。

### C3. 录制期间的导航分类

`framenavigated` 处理器（`record.ts:482` 起）按证据把主 frame 导航分类为 `initial / user_navigate / user_link / sso_redirect / login_redirect / auto_redirect / unknown_navigation`：

- 地址栏导航：host `userNavigateRequested`（B2 记录）＋30s 窗口 URL 匹配 → `user_navigate`。
- 点了带 href 的元素 → `user_link`。
- 命中内置 IdP 模式（`classify.ts:13` host `login|logon|auth|sso|signin|identity|idp`、path `/login|oauth|saml…`）→ `sso_redirect/login_redirect` → **不进合流**，单独合成为 `isOptional` navigate 步骤（回放时浏览器已自行跳转就跳过）。

### C4. 录制画面（视频帧）

主进程 800ms 采帧（C1.5）→ `recording:captureFrame` → bridge 处理器（`renderer/bridge.js:1551`）把 dataUrl 画进 `state.mediaCapture.canvas`（叠加 `Tab N · URL` 标签）+ 每帧存一张截图（去重 by index）。MediaRecorder 持续录 canvas → 停止时得到 webm。

### C5. 停止录制（Stop 按钮 / 关抽屉确认）

```
#prepareRecording（录制中显示 Stop）→ finishBrowserRecording（覆盖版，renderer/bridge.js:503）
  空录制（pending.actions 空）：确认 → F.recording.stop({discard:true}) fire-and-forget
      → exitEmptyRecording（renderer/bridge.js:483）直接恢复界面
  非空：
    ① pending.finishing=true（拦截重复 Stop）
    ② engineStop = F.recording.stop() + mediaStop = stopRecordingMedia(state)
       （覆盖版含 1.5s 超时兜底：recorder.stop / FileReader 卡住不会困死用户）
    ③ await engineStop → 主进程 stopRecordingSession（src/main.ts:734）：
        - recStopRequested=true；recController.abort()（打断启动期等待）
        - await recPromise（recorder 冲洗最后一批 → refineSteps 清理 → saveFlow 落盘）
        - writeFlowForgeArchive（.raw.json 旁证 sidecar，失败仅告警）
        - stopRecordingCapture（补最后一帧，硬上限 850ms）
        - 组装 RecordingMeta（poster=首帧、frames、stepScreenshots 目录扫描）
        - TaskStore.addRecording → 元数据落 tasks.json
        - !isMerged && isAutoRefineEnabled() → fire-and-forget autoRefineRecording（见 C6）
        - 推 recording:done {recording}
    ④ 渲染层拿 result.recording：F.flow.load(flowFile) → flowStepToText/flowStepToDetail
       （renderer/bridge.js:1109）→ buildGroupsFromSteps 分组 → media 截图对齐
       → videoDataUrl 有值则 F.recording.saveVideo 落 webm（recording:saveVideo）
       → item 入 state.items，焦点切到它，view='analysis'，hideNativeBrowser
       → startFlowLinkAIAdvice({mode:'recording-complete'})（见 F6）
    空结果（reason==='empty' 或无 recording 且无 fallback 步骤）→ exitEmptyRecording
```

**引擎侧收尾**（`record.ts:1441` 起）：stopPromise resolve → `flush(true)` 强制冲洗 → 残留对话框补成末尾 dialog 步骤、残留下载挂到最后一步 expect → `clearUids`（清 `data-rr-uid` 标记）→ `refineSteps`（同目标连续 input 合并为最后一次；可编辑元素上 click+input 丢 click）→ id 连续化 s1..sN → 0 步抛 `EmptyRecordingError`（正常取消）→ `saveFlow`（**写前 Zod 校验，非法 IR 不落盘**）。

### C6. 自动细化（REFINED 孪生录制）

```
主进程 autoRefineRecording（src/main.ts:691）
  → piStatus()（src/pi-agent.ts:412：readSettings + validateAuthFile；不可用 → 事件 {state:'skipped'}）
  → generateRefinedFlow({flowFiles:[源], mode:'auto', templates, runPrompt})
      （src/ai-refine.ts:657；管线详见 F4）
  → 成功 → refinedRecordingName（REFINED-MMDD-HHmm，重名追加 (2)）
      → persistMergedFlow（src/main.ts:644：新 recording_<id>.json，永不覆盖源录制，isMerged:true）
      → 推 ai:autoRefine {state:'done', sourceRecordingId, refinedRecordingId, name}
  → 失败 → ai:autoRefine {state:'failed', error}
渲染层（renderer/bridge.js:1620）：skipped 静默；failed → showFlowlinkNotice('warn')；
  done → loadTaskDetails(force) 按 recordingId 保留旧条目、追加新条目 + 提示条
开关：config/pi-settings.json `autoRefine:false`（isAutoRefineEnabled，src/pi-agent.ts:132）
```

### C7. 删除录制（录制列表行 × 按钮）

```
deleteRecording(id)（renderer/app.js:3132）→ 确认框
  → F.tasks.removeRecording → tasks:removeRecording（src/main.ts:871）
      → removeRecordingFiles（Flow JSON/.bak/.raw.json + artifacts + capture 目录，守卫同 A6）
      → TaskStore.removeRecording
  → 本地条目移除、焦点/阶段推导、重渲染
```

### C8. 分组重录（Process 组卡 Re-record / Add before / Add after）

```
bridge beginGroupRecording（覆盖版，renderer/bridge.js:726）
  ① 确认框；state.groupPreparing=true（防重入）
  ② F.flow.load(item.flowFile) → flatFlowSteps → 计算边界 stepCount
     （replace/before=组起点；after=组终点）
  ③ 关多余标签页 → F.browser.restart(startUrl)（见 B5）
  ④ stepCount>0 → F.playback.runPrefix({taskCode, recordingId, stepCount})
       → playback:runPrefix（src/main.ts:1278）
           - loadFlow → flattenSteps → prefixSteps（engine/executor/src/steps.ts:54，
             保留 group 结构、剪除指向已不存在组的分支目标）→ parseFlow 校验临时前缀 Flow
           - resetBrowserTabs(startUrl) → attachPlaybackPages
           - playOnPage（同 E2 内核，stopOnFailure、openPage=createNativePlaybackPage(false)）
           - onPage 回调轮询 engine.tabIdForPage 收集 tabIds 映射（40×50ms）
           - 失败 → 返回 {ok:false,error}，不启动录制
  ⑤ 前缀成功 → 按 replay.currentPageIndex 对齐 UI 活动页 → F.browser.switchTab
  ⑥ startBrowserRecording({preservePage:true})（跳过导航，接着当前 DOM 录）
失败回滚：清 pending、回分析视图、alert 原因
停止后：finishBrowserRecording → pending.groupId 存在 → finishGroupRecording
  （renderer/app.js:5873）→ 用新录制步骤 replace/插入 processFlow.steps
  → persistProcessFlow（走 flow:updateSteps 校验保存，见 D2）
```

---

## 6. 场景 D：分析工作区

### D1. 打开一条录制（点击录制名）

```
renderRecordingItems onclick（renderer/app.js:2429）→ state.focused / view='analysis'
  → renderRecordingWorkspace（renderer/app.js:2365）→ renderSummaryWorkspace（renderer/app.js:2990）
  → 默认 resultTab='Process'；首次进入 Process/Test 且未加载 → hydrateProcessFlow(item)
      （renderer/app.js:4350）
        → F.flow.load → 顶层不是全 group 时按 ensureProcessGroups 包组
        → item.processFlow / processFlowLoaded / syncProcessFlowPresentation
          （重建 item.steps 文本、stepDetails、processGroups）
```

### D2. Process 流程图与分组编辑

**渲染**（`fillProcessPanel`，`renderer/app.js:1330`）：

```
FlowGraph.buildGraph(flow)（renderer/flow-graph.js:75）
  → 按 step.sourceFlowId 分段（AI 融合的多来源 = 多个连通分量）
  → 节点=顶层组/未分组伪组 + 尾置 condition 提取为菱形判断节点 + 每段 Start/End 哨兵
  → 边=顺延实线 + condition 是/否分支边 + 回跳虚线（受运行时 3 次限制）
先渲染组卡 DOM（量尺寸）→ FlowGraph.layoutGraph(graph, measure)（flow-graph.js:333）
  → 每个连通分量各跑一次 window.__flowlinkDagre → 绝对定位
→ drawProcessGraphEdges（renderer/app.js:1140）画 SVG 折线边
  （回放态：走过的高亮、未走的淡化 + "已走/未走"标签）
回放态来源：item.testResults 按 flattenedStepId 建映射叠加到步骤行/组卡描边/边
多来源组卡按 meta.sourceFlows 顺序着色 + 图例
```

`window.__flowlinkDagre` 缺失（`dist/renderer-vendor.js` 没构建）→ 画布显示明确错误，**无串行回退**。

**分组操作**（`bindProcessMap`，`renderer/app.js:5474`，全部经 `persistProcessFlow` 持久化）：

| 操作 | 处理函数 | 说明 |
|---|---|---|
| 新增空组 | `addProcessGroupAfter`（app.js:5186） | `showProcessGroupDialog` 命名 → 插入 |
| 组内加步骤 | `showManualStepEditor`（app.js:5212） | 元素类步骤只能**复用录制已捕获的 ElementRef**（下拉选既有步骤的 target）；input 自动建 `{{变量}}`；condition 只能做组尾 |
| 重命名 | `renameProcessGroup`（app.js:6079） | |
| 上移/下移 | `moveProcessGroup`（app.js:6098） | |
| 并入下一组 | `mergeProcessGroupIntoNext`（app.js:6116） | 组尾是 condition 时拒绝（契约要求 condition 必须是组最后一步） |
| 删除组 | `deleteProcessGroup`（app.js:6018） | 至少保留一组；指向它的分支改为"到该分支结束" |
| 步骤右键 Break 拆组 | `canvasStepMenu`（app.js:5721） | 真拆 `processFlow.steps`；失败回滚并提示 |
| 步骤右键 Modify | 同上 | 跳 Instruction 并聚焦对应行 |

```
persistProcessFlow(item)（renderer/app.js:4412）
  → F.flow.updateSteps({taskCode, recordingId, steps})
      → flow:updateSteps（src/main.ts:1641）
          → loadFlow → parseFlow({...flow, version+1, steps})（完整 Zod+契约校验）
          → saveFlow(updated, flowFile, {backup:true})（.bak 备份）
  → 回写 item.processFlow.version/steps → syncProcessFlowPresentation → rebuildItemTestFlow
  契约错误会内联显示在对话框/流程图错误条（item.processFlowError），磁盘 Flow 未动
```

编辑期间守卫（`fillProcessPanel`）：Flow 未加载 / 录制中 / 回放运行中 → 按钮 disabled + title 说明原因（按钮永不"无解释地变灰"）。

### D3. Instruction 与 Reference

**Instruction**（`fillInstructionPanel` + `bindStepEditor`，app.js:1798/4611）：编辑即改本地草稿（`item.steps/stepDetails`，`item.nodeUpdates=true`）→ `rebuildItemTestFlow(item)`（app.js:4587：优先 processFlow，其次未编辑时读已存 Flow，否则从草稿重建）→ Test 反映最新内容。操作类型选择器复用 Service Level 同款组件（`wireStepTypePicker`）。

**Reference**（`bindReferenceFiles`，app.js:4867）：

- 首次打开自动生成 `录制名.xls/.md`（纯渲染层 Blob）；`hydrateReferenceVariables`（app.js:4793）从 Flow 拉变量（secret 显示 ••••••）。
- 变量增/改/删 → `persistReferenceVariables`（app.js:4857）→ `flow:updateVariables`（`src/main.ts:1618`，parseFlow(version+1) + saveFlow）。**secret 值只存渲染层内存**，回放时经 `referenceVariablesForReplay`（app.js:4844）随 run 传入，不落盘。
- 上传文件：纯本地（`referenceFileInput`，含原生选择器取消误触 Close 的三层防护）。
- 下载 ZIP：`downloadReferenceArchive`（app.js:6156）渲染层手写 ZIP（含 CRC32）。

### D4. Record 页与 Metric 页

Record（`fillRecordPanel`，app.js:1917）：webm（`file:///` 协议，需 `recording:saveVideo` 已落盘）或首帧 poster + 步骤截图九宫格（点击放大）。Metric（`fillMetricPanel`）：指标勾选存 `localStorage`（`taskflow-metric-consent:<code>`），演示性质、无 IPC。

---

## 7. 场景 E：测试回放与 AI 接管

### E1. 进入 Test 标签（自动运行）

```
点击 summaryTabTest → renderSummaryWorkspace 内 tabButtons.onclick（renderer/app.js:3100）
  → resetTestExecutionStatus(item)（全部置 pending）
  → state.aiOpen=true（AI 面板自动展开，显示进度）
  → active==='Test' && testBrowserResetKey!==item.id
      → resetTestBrowser(item)（覆盖版，renderer/bridge.js:832）
          （录制中先收尾；关多余标签页；F.flow.load 取 startUrl；
            F.browser.restart(startUrl) → B5 链路；finally 回 Test 视图重渲染）
  → autoRunTest(item)（renderer/app.js:3082）
      → await state.testResetPromise → 会话/条目守卫（防切 taskflow 后旧回放串台）
      → window.runFlowlinkTest(item)
```

### E2. 发起回放（runFlowlinkTest，`renderer/bridge.js:1288`）

```
① 守卫：item 属于当前会话（跨 taskflow 的迟到调用直接忽略）
② F.flow.load(item.flowFile) → FlowGraph.flattenFlowSteps
    → item.testFlowSteps + testFlowIndexById（stepId→下标，事件对齐的关键）+ testResults 全 pending
③ item.testRunning=true；activePlaybackScope={code,itemId}（事件归属域）
④ variables = await referenceVariablesForReplay(item)（含 secret）
⑤ F.playback.run({taskCode, recordingId, variables})
    → playback:run（src/main.ts:1362）
```

主进程 `playback:run`：

1. 守卫：`playPromise` 占用 → "已有回放正在进行"；engine 就绪；录制存在；变量名/类型校验（`/^[A-Za-z_][A-Za-z0-9_]*$/`）。
2. `loadFlow(recording.flowFile)` → **`resetBrowserTabs(flow.meta.env.startUrl)`**（每次完整测试从录制声明的起始 URL 重建）→ `attachPlaybackPages()`（逐标签 `engine.pageFor`）→ 显式恢复浏览器可见（`browserSurfaceVisible=true; ensureBrowserBounds(); syncBrowserVisibility()`，防 reset 隐藏后几何去重不再上报导致整场白屏）。
3. `playAbortController`；`playPromise = playOnPage({...})`（`engine/executor/src/index.ts:81` → `executeRunOnPage`（`run.ts:1118`）→ `runFlowInBrowserContext`（`run.ts:257`）），参数：`timeoutMs:15000, stepDelayMs:350, highlightSteps:true, stopOnFailure:true, variables, abortSignal, waitForUserOperation`（token 挂 `pendingUserOperationWaits` + 推 `playback:userOperation`），`openPage:createNativePlaybackPage(true)`（**Electron 回放禁用 Playwright `Target.createTarget`，开页=建原生标签页再附着**，`src/main.ts:373`），`onStep` → 推 `playback:step`。
4. `await playPromise` → 推 `playback:done result` → `TaskStore.patchRecording lastRun` → 返回。异常 → 推 `playback:error` + 返回 `{ok:false,error}`（事件与返回值双通道）。

### E3. 执行内核逐步流程（`runFlowInBrowserContext`，`engine/executor/src/run.ts:257`）

每个展平步骤（`flattenSteps`，`steps.ts:25`，stepId 规则 `组id/步骤id`）：

```
① 组访问计数：同组第 4 次进入 → FLOW_LOOP_LIMIT 失败
② abortSignal 已中止 → 补报 skip 并 break；页面崩溃 → 逐项 skip continue
③ 可选导航（isOptional + previousUrl）：等 800ms（OPTIONAL_NAV_WAIT_MS）
    → sameSitePath(当前URL, previousUrl) 不一致 = 重定向已自行发生 → skip
④ 可选元素步骤（isOptional + target）：2s 内（OPTIONAL_ELEMENT_WAIT_MS）解析不到
    → ElementNotFoundError → skip（登录组容忍：已登录时凭据字段不出现）
⑤ 目标标签页 resolveStepPageIndex → pages.focus；manual 模式对话框挂起检查
⑥ renderStep 模板渲染（{{变量}} 替换；navigate 再 rebaseUrl）
⑦ settle：有 settle 字段 → waitForSettle（settle.ts:28，networkIdle/domQuietMs，
    共享 maxMs=10s，超时只记日志不失败；navigate/wait 步骤跳过）
⑧ 分派执行：
    openTab/closeTab/switchTab → PageManager（tabs.ts:65）
    dialog → DialogManager.resolve（dialogs.ts）
    condition → evaluateAssertion（verify.ts:313，瞬时判定）
      → branchCursor = 目标组起始下标（缺目标=分支结束=flat.length）
    wait userOperation / execution:manual → opts.waitForUserOperation（见场景 G）
    assert → runAssertion（verify.ts:223，默认等 5s，step.timeout 钳 1-30s）
    其余 → runAction（actions.ts:128）：
      navigate=goto(load)+尽力 networkidle；click=trial 检查→真点（对话框赛跑）；
      input=fill/pressSequentially；select=按值→按 label 兜底；upload=setInputFiles
      （文件不存在→NOT_ACTIONABLE）；key=组合键；hover/scroll/drag/extract（写运行时变量）
⑨ 无 expect 的 click/drag → NO_EFFECT 探测 assertEffect（run.ts:1292：
    DOM mutation / url / 对话框 / 下载 / 新标签页 / 焦点变化 / 像素对比，全静默才失败）
⑩ expect 校验 verifyExpect（verify.ts:105：urlChange/elementVisible/elementHidden/
    textChange/download/domSignature，轮询默认 5s）
⑪ 失败 → classifyError（errors.ts:67，按阶段 resolve/action/expect/template/navigate
    归语义码）+ appendLoginExpiredHint（URL 像登录页时附提示）
    → artifacts.writeStepArtifacts（before/after 截图+snapshot.json+log.txt）
    → stopOnFailure → break
⑫ condition 分支跳转 → 被跳过的步骤逐个补报 skip（结果与展示序一一对应）
    → flatCursor = branchCursor - 1
收尾 finally：保存登录态（可选）→ 关残留对话框 → 等下载落盘 → 只关自建 context
产物：result.json + <idx>/ 截图快照日志 → artifacts/<flowId>/runs/<runId>/
```

**元素解析**（`resolveTarget` → `resolver.resolve`，`engine/resolver/src/index.ts:163`）：

```
assertRefSane 结构自检 → enterFrameScope（iframe 链）→ waitForLoadState
第一轮 L1 resolveL1（语义候选；HIDDEN 在 elementWaitMs 内轮询重试）
       → L2 resolveL2（stableHash 指纹池；属性相等读原始 attributes）
第一轮没找到（非 HIDDEN）→ waitForAnyCandidate 等 SPA 首屏 → 第二轮
L4 AI 兜底：桌面版 opts.ai 未注入 → 永远跳过（日志会写"L4 跳过：未注入 AI repair"）
全部失败 → ElementNotFoundError(code=AMBIGUOUS|HIDDEN|NO_MATCH, detail 含各级失败原因+候选清单)
```

### E4. 回放事件 → 界面状态对齐（bridge.js）

```
playback:step（renderer/bridge.js:1666）
  → playbackScopedItem() 归属校验（activeFlowKey+itemId 都得对上，防跨会话串台）
  → 下标定位：优先 item.testFlowIndexById.get(r.stepId)
    （分支跳过后执行序≠展示序，必须按 stepId；找不到再回退 running/pending 启发式）
  → 写 testResults[i]；pass/skip 推进下一个 running 标记；fail 停止推进
  → resultTab 是 Test/Process → renderSummaryWorkspace()（Test 列表/Process 图实时刷新）

playback:done（renderer/bridge.js:1735）
  → 归属校验失败 → clearStaleRunFlag（把发起录制的 testRunning 就地清掉）
  → 以 result.steps 按 stepId 建映射**覆盖**流式暂存（最终结果权威）
  → 本 run 没有结果的步骤保持 Pending；skip 仅来自引擎 skip 事件
  → !ok → startFlowLinkAIAdvice({mode:'replay-failure', failureContext:{…全部结果}})

playback:error（renderer/bridge.js:1860）→ running 步骤标 fail + 自动失败诊断
```

### E5. 停止回放

Test 运行中 AI 面板的发送键变 Stop（`renderAIPanel`）→ `stopFlowlinkTest`（`renderer/bridge.js:1325`）→ `F.playback.stop` → `playback:stop`（`src/main.ts:1479`）：AI 接管进行中 → `abortAiTakeover`；否则 `playAbortController.abort()` + 等 playPromise 收尾（内核对剩余步骤补报 skip）。渲染层把 running 步骤标 'Stopped by user'。

### E6. AI 接管（Run remaining steps with AI）

**入口**：Test 有失败步骤且无运行中回放时，AI 面板快捷区出现 `#aiContinueTest`（`renderer/app.js:3632`）。

```
window.aiContinueFlowlinkTest(item)（renderer/bridge.js:1340）
  → fromStepIndex = 第一个 fail 的下标；testRunning=true；referenceVariablesForReplay
  → F.playback.aiContinue({...fromStepIndex, variables, failureSummary})
      → playback:aiContinue（src/main.ts:1494）
          守卫：无回放/无录制会话/无进行中接管/engine 就绪 → loadFlow →
          fire-and-forget startAiTakeover({...})，进度走事件：
            deps.cdpUrl = engine.cdpHttpEndpoint()（附着同一个内嵌浏览器）
            modelConfig = getTakeoverModelConfig()（pi-settings 的 provider/model
              + pi-auth 的 key；provider=custom 时 baseUrl 取 config/models.json）
            proxy = getPiProxyOptions()；resolveSystemProxy = session.resolveProxy
            onStep → 推 playback:aiStep；onDone → 推 playback:aiDone
              + patchRecording lastRun{aiAssisted:true, summary}
```

**startAiTakeover**（`src/ai-takeover.ts:358`）要点：

- 展平剩余步骤；secret 变量进 `sensitiveData`（SDK 脱敏 + 域名限定 `allowedDomains`=Flow 证据里的全部主机名）；总预算 10 分钟、每步最多 14 个 agent 步、150s 超时、失败重试 1 次。
- `preferSystemNodeWorker`（Electron 里优先用系统 Node ≥22.19 跑 SDK 的 REPL worker）→ `applyProxyDispatcher`（undici 全局代理）→ `BrowserUse.create`（模型集合用嵌套 `@browser_use/pi/node_modules/@earendil-works/pi-ai` 的 openai-completions API 构建）。
- 每步任务 = `templates.stepTask`（config/prompts.json）填充的投影文本（`projectStepText`，secret 显示占位指令）；**完成判定双门槛**：agent 调 `mark_step_done` 工具（stepIndex 必须匹配）且 typed 结果 `done===true`。
- 遇到 `upload/switchTab/openTab/closeTab/script` 或 `wait userOperation` → 中止接管（剩余保持 pending）；单步两次失败 → 中止。
- 产物：`artifacts/<flowId>/runs/<runId>/ai-takeover.json`。**绝不写回源 Flow。**

**渲染层**（`renderer/bridge.js:1775/1817`）：`aiStep` 只写 pending/running 槽位（防迟到事件覆盖已定状态），带 `ai:true` 徽标；`aiDone` → running 重置回 pending、记录 `item.lastTakeover`、聊天写总结；**aiCompleted>0 时自动触发** `window.aiRepairFlowAfterTakeover(item)`。

### E7. 接管后的自动流程修复

```
aiRepairFlowAfterTakeover（renderer/bridge.js:1375）
  → 汇总 failedSteps（stepId/label/error）与 aiSteps（AI 实际完成的证据）
  → F.pi.repairFlow({taskCode, recordingId, takeover:{ok,summary,aiCompleted,failedSteps,aiSteps}})
      → pi:repairFlow（src/main.ts:1064）
          → 组装修复指令（最小改动原则：调校验目标、加 settle/timeout、
             不发明选择器/URL、保留元素引用与 isOptional/登录组结构）
          → generateRefinedFlow（同 F4 管线）
  → 成功 → F.recording.persistMerged 另存 REPAIRED-MMDD-HHmm（原始不动）
      → loadTaskDetails(force) 刷新 → 聊天写结果与风险
```

---

## 8. 场景 F：AI 面板

### F1. 打开面板与预热

`#aiToggle` → `state.aiOpen` 切换 → `renderAIPanel`（`renderer/app.js:3515`）→ 首次 `prewarmPiOnce` → `F.pi.prewarm` → `pi:prewarm` → `prewarmPi()`（`src/pi-agent.ts:392`）：校验 `config/pi-settings.json` + `config/pi-auth.json` → spawn worker（`getPiWorker`）→ `createRuntime`（`pi-agent-worker.ts:158`：加载 Pi SDK、按 authPath/provider/model 建缓存键；**不发起 provider 请求**）。窗口出现后 1.5s 主进程也会预热一次。

### F2. 发送消息（建议/advice 管线）

```
#assistantSend / Enter → submitAssistantMessage（renderer/app.js:4112）
  → invokeAIMerge('input', message, {attachments}）（renderer/app.js:3935）
      → 用户消息入 chat（含 @附件 芯片）；附件集合发送后即清空
      → 生成式请求判定：extra.forceMaterial || aiRequestNeedsMaterial(text)
         （正则识别"生成/优化/修复 流程/材料"类措辞，app.js:3832）
      ├─ 是 → generateRefinedMaterial（F4）
      └─ 否 → askPiForAdvice（renderer/app.js:3866）
           → piPromptTemplates()（缓存；F.pi.promptTemplates → pi:promptTemplates
              → getPromptTemplates → loadPromptTemplates 校验 config/prompts.json）
           → aiMaterialContext：逐附件 F.flow.load 取真实 Flow（步骤/元数据/变量/测试结果）
           → formatPiTemplate(templates.advice.prompt, {mode, conversation(近8轮,12k 上限),
              userRequest, materialContext(65k 上限), executionContext})
           → F.pi.prompt({prompt, timeoutMs:120000})
              → pi:prompt（src/main.ts:1601）→ runPiPrompt（src/pi-agent.ts:437）
                 → sendPiWorkerRequest → worker runPrompt（pi-agent-worker.ts:214）
                    → createAgentSession（noTools:'all'，systemPrompt=prompts.json systemPrompt，
                       会话内存态）→ session.prompt → getLastAssistantText
           → 回复替换 "Pi is reviewing…" 占位消息
```

模式（`state.aiTaskMode`）：`material-refinement`（默认）/ `replay-failure`（Test 页）/ `recording-complete`，影响模板 mode 与默认请求文案（`templates.advice.defaults`）。

### F3. @ 提及与附件

输入 `@` 触发提及选择器（`updateMentionPicker`，app.js:3435，↑↓/Enter/Tab/Escape 键盘可达）→ `chooseMention` 把录制 id 塞进 `state.aiAttachments` → 渲染芯片（`renderAttachmentChips`）。**Flow JSON 永不进聊天记录**——transcript 只存文本与 `{id,name}` 芯片，载荷由主进程按 recordingId 自行组装。

### F4. 生成细化流程（Refine / 指令式生成）

```
渲染层 generateRefinedMaterial（renderer/app.js:3882）
  → 守卫：所有选中材料必须有已保存 Flow（recordingId）
  → F.pi.generateFlow({taskCode, recordingIds, instruction, conversation})
      → pi:generateFlow（src/main.ts:995）
          → 逐 recordingId 解析 recording + loadFlow 源（含 flowId/title 溯源元数据）
          → generateRefinedFlow（src/ai-refine.ts:657）：
              ① loadFlow 全部源 → projectFlows（元素库 LibraryBuilder；库>10k 字符或
                 步骤>60k 字符 → 明确报"拆分流程"，绝不静默截断）
              ② 提示词：mode=auto → buildAutoSanitizePrompt；否则 buildRefinePrompt
                 （instruction 4k / conversation 12k / 总上限 100k）
              ③ runPrompt = runPiPrompt（cwd=flowsRoot）
              ④ extractJsonObject（围栏代码块→整体→括号配对扫描，三级兜底）
              ⑤ rehydrateSteps：元素字段**只接受 {"$ref":"eN"}**，内联元素对象一律拒绝；
                 id 冲突加 -2/-3 后缀
              ⑥ sources 提供时 annotateSourceFlowIds（按元素库 origin 投票推断
                 每步 sourceFlowId，供 Process 图分段着色）
              ⑦ mergeVariables + collectTemplateRefs 守卫：
                 引用不存在的变量 → 整次失败；剪除未被引用的变量；
                 secret 变量被丢弃 → 追加 risk 提醒
              ⑧ parseFlow('<ai-refine>') 完整校验 → 返回（不落盘）
  → 成功 → F.recording.persistMerged（recording:persistMerged → persistMergedFlow，
      新 REFINED 文件，原始不动）→ 新条目入列表并聚焦 → 聊天写 rationale/risks
```

### F5. Refine 按钮（选中 ≥1 条已分析录制）

`#summarizeRecordings` → `summarizeRecordings`（app.js:2880）：守卫（必须全部 analyzed）→ `state.aiMode='refine-options'` → 面板渲染 5 个预设（REFINE_PRESETS）+ 自由文本 → `submitRefineOptions`（app.js:3348）拼成 instruction → `invokeAIMerge('input', instruction, {forceMaterial:true})` → F4。

### F6. 自动建议触发点（`window.startFlowLinkAIAdvice`，app.js:3996）

| 触发 | 位置 | mode |
|---|---|---|
| 录制停止后 | bridge `finishBrowserRecording` 成功/回退路径 | `recording-complete` |
| 回放失败结束 | bridge `playback:done`（!ok） | `replay-failure`（带全部结果作 failureContext） |
| 回放异常终止 | bridge `playback:error` | `replay-failure` |

内置**会话守卫**：用户已切换/关闭 taskflow 时诊断只留在源录制聊天里，绝不改当前会话焦点。

---

## 9. 场景 G：回放中的人工确认

两类步骤会把回放挂起等待用户确认（`waitForUserOperation` 回调，主进程 `playback:run` 内构造，`src/main.ts:1406`）：

- `wait` 步骤 `condition=userOperation`（提示文本取 `step.prompt`）
- 任意步骤 `execution=manual`（人工步骤，提示取 label）

```
内核 opts.waitForUserOperation({stepId, prompt, signal})
  → 生成 token → pendingUserOperationWaits.set(token, resolve)
  → 推 playback:userOperation {token, stepId, prompt}
渲染层（renderer/bridge.js:1710）→ 显示 #playbackUserOperation 提示条 + Continue
  → F.playback.continueUserOperation(token) → playback:continueUserOperation
     （src/main.ts:1472）→ resolve 该等待 → 回放继续
Stop/窗口关闭 → signal abort → 等待以"用户操作等待已取消"失败
```

---

## 10. 持久化数据全景

| 数据 | 路径 | 写入者 | 机制 |
|---|---|---|---|
| 任务与录制元数据 | `<userData>/flowlink/tasks.json` | `TaskStore.persist`（`src/store.ts:99`） | tmp+rename 原子写；读失败按空库 |
| Flow IR | `<userData>/flowlink/flows/<id>.json` | `saveFlow`（`engine/schema/src/io.ts:91`） | 写前 parseFlow 全量校验；tmp+rename；`backup:true` 留 `.bak` |
| 原始事件证据 | `flows/<id>.raw.json` + FlowForge sidecar | recorder `keepRaw` / `writeFlowForgeArchive` | 输入值掩码（value 删除、masked:true） |
| 录制产物 | `artifacts/<flowId>/record/{elements,screenshots,video}/` | recorder | 元素裁剪图 / step-NNNN.png / （截帧在独立 recording- 目录） |
| 截帧视频帧 | `artifacts/recording-<ts>/record/video/frame-NNNN.png` | 主进程 `captureRecordingFrame` | 800ms 间隔；空录制/取消时整目录清理 |
| webm 视频 | `artifacts/<recordingId>/record/video/recording.webm` | `recording:saveVideo` | 渲染层 MediaRecorder 产物 base64 落盘 |
| 回放产物 | `artifacts/<flowId>/runs/<runId>/{result.json, <idx>/before.png,after.png,snapshot.json,log.txt, downloads/}` | `ArtifactWriter`（`executor/artifacts.ts:79`） | `sanitizeSegment` 防路径逃逸 |
| AI 接管轨迹 | `runs/<runId>/ai-takeover.json` + `agent-workspace/` | ai-takeover | secret 经 SDK 脱敏，不进产物 |
| 提示词模板 | `config/prompts.json`（随包） | 人工维护 | `loadPromptTemplates` 强校验缺一不可 |
| Pi 配置 | `config/pi-settings.json`（provider/model/thinkingLevel/timeoutMs/autoRefine）、`config/pi-auth.json`（密钥）、`config/models.json`（custom baseUrl） | 人工维护 | 打包后 pi-auth 移到 userData |

**Flow 版本迁移**：`migrateFlow`（`io.ts:40`）v0→v1→v2 逐级，未来版本明确拒绝。**删除守卫**：`removeRecordingFiles`（`src/main.ts:156`）拒绝删除管理目录之外/命名不符的文件。

---

## 11. 故障定位手册

> 用法：按"症状"找条目 → 沿调用链从后往前查。日志都在**主进程 stdout**（`npm start` 的终端）；渲染层问题开 `--dev` 看 DevTools console。

### 启动与窗口

| 症状 | 先查 | 说明 |
|---|---|---|
| 应用起不来 | `node build.mjs` 是否报错 | start.mjs 先构建后启动；esbuild 失败直接退出 |
| 窗口出来但浏览器区域空白 | ① `browser:setBounds` 是否到达（bridge `reportBrowserBounds`）② `#browserFrames` 矩形是否 ≥2×2 ③ `syncBrowserVisibility` 三条件 | bounds 有几何去重：隐藏后同尺寸恢复不会自动重报——`hideNativeBrowser` 负责清缓存，绕过它直接 `F.browser.hide` 会复现"永远隐藏" |
| 确认对话框被浏览器盖住 | `confirmWorkspaceAction` 覆盖版是否生效（bridge.js:404） | 原生视图 z 序高于渲染层，必须先隐藏再显示 |
| Process 图白屏/报"布局引擎未加载" | `dist/renderer-vendor.js` 存在与否 | `npm run build` 后重启；无串行回退是有意设计 |
| Service Level 下拉全禁用 | `process_landscape/full.json` 解析 | `setProcessLandscapeError` 会把错误写进 `#profileSaveStatus` |

### 录制

| 症状 | 先查 | 说明 |
|---|---|---|
| 点 Record 没反应 | ① stage 是否已是 recording ② 主进程"已有录制正在进行"/"引擎未就绪"日志 ③ `DevToolsActivePort` 文件（waitForCdpPort 8s 超时） | 启动失败时 bridge 会把 UI 回滚 ready 并重绘 |
| 录制没生成步骤 | ① 页面 console 里 `capture.js` 是否注入成功（`[perf] recording-session` 的 reinjectFailed/popupsNeverCaptured 计数）② 步骤是否在等"静默 500ms+布局稳定"（长动画页 MAX_SETTLE_MS 5s）③ popup 页（about:blank 起始）多次注入失败计数 | `recording:step` 只是计数；真正的步骤看落盘 Flow |
| 某步没录上（拖拽/悬停） | drag：起/终点任一无法复核则不成步（保留证据）；hover：需 2s 内有后续点击才算有意义 | 有意丢弃，告警在 `.raw.json` warnings |
| Stop 一直转 | ① bridge `stopRecordingMedia` 的 1.5s 超时兜底 ② 主进程 `stopRecordingSession`：等 `recPromise` 冲洗 ③ stopRecordingCapture 硬上限 850ms | 重复 Stop 共享同一 recStopPromise，不会双写 |
| 空录制弹确认后没生成条目 | 正常：EmptyRecordingError = 干净取消 | 只有 fallback 步骤存在时才建"回退条目"并触发建议 |
| REFINED 孪生没出现 | ① `ai:autoRefine` 事件 state（skipped=Pi 未配置属正常；failed 看 error）② `config/pi-settings.json autoRefine` ③ `.raw.json`/步骤是否超细化预算（元素库 10k/步骤 60k 字符） | 源录制永远不被覆盖 |
| 地址栏导航没记成步骤 | host `userNavigateRequested`（30s 窗口 + URL 精确匹配）与页面 navigation 事件是否对上 | 对不上会落成 `unknown_navigation` 证据但仍进合流 |
| 分组重录失败"Prefix playback failed" | `playback:runPrefix` 返回的 error；主进程 `[playback:prefix]` 日志 | 前缀失败不启动录制，回到分析视图 |

### 分析与编辑

| 症状 | 先查 | 说明 |
|---|---|---|
| 打开录制只有步骤文本、图/编辑不可用 | `hydrateProcessFlow` 的 `item.processFlowError`（Flow 加载失败会显示在画布错误条） | 编辑按钮 disabled 时 title 写明原因 |
| 保存分组/步骤被拒 | `flow:updateSteps` 抛的 FlowValidationError（对话框内联/`processFlowError`） | 典型契约：condition 必须是组尾且目标是存在的非空组；密码值必须 `{{password}}` |
| Test 列表与 Process 图步骤对不上 | 两边都必须走 `FlowGraph.flattenFlowSteps`（flattenedStepId 一致） | 手写展平逻辑是历史 bug 源，勿再引入 |
| 变量改了回放没生效 | secret 只在渲染层内存（页面刷新即失）；非 secret 默认值才落 Flow | 回放变量链：`referenceVariablesForReplay` → `playback:run` → `renderStep` |

### 回放

| 症状 | 先查 | 说明 |
|---|---|---|
| 进入 Test 不自动跑 | ① `resetTestBrowser` 是否完成（testResetPromise）② `autoRunTest` 的会话守卫（切过 taskflow 会放弃）③ item.testRunning / playbackInFlight | |
| 步骤报 ELEMENT_NOT_FOUND | 该步骤 `log.txt` 里的 `  resolve: L1/L2 失败（AMBIGUOUS/HIDDEN/NO_MATCH）：…` 逐级明细（resolver 经 log 回调写入步骤日志）；snapshot.json 存归类后的 code 与摘要。再看 `.raw.json` 证据与页面改版 | 桌面版 L4 恒关闭；修复路径：AI 接管 → 自动 REPAIRED，或人工编辑候选 |
| 步骤报 NO_EFFECT | assertEffect 日志（effect: …） | 七类副作用信号全静默才判；focus ring 变化已排除 |
| 登录段在已登录时失败 | isOptional 机制（录制时认证跳转自动带 isOptional；AI 细化的"门条件+容忍登录组"结构） | 可选元素 2s 不出现=skip；可选导航 800ms 后按 sameSitePath 判 |
| 回放中浏览器空白 | `playback:run` 的显式恢复（browserSurfaceVisible/ensureBrowserBounds）没执行或 bounds 丢失 | reset 会隐藏视图且几何去重可能不重报——主进程特意显式恢复 |
| Test 结果与实际执行错位 | `playback:done` 按 stepId 覆盖（执行序≠展示序）；`testFlowIndexById` 是否来自最新 Flow | runFlowlinkTest 每次都重新 flatten |
| FLOW_LOOP_LIMIT | condition 回跳组第 4 次进入 | 每组每次运行最多进 3 次，硬上限 |
| 卡在"用户操作" | `#playbackUserOperation` 提示条 Continue；或 Stop（signal abort 会以取消失败） | |
| Run 按钮（列表行）没反应 | 任务 enabled？有录制？`runFlow` 用**最后一条**录制 | |

### AI（Pi / 接管）

| 症状 | 先查 | 说明 |
|---|---|---|
| "Pi could not respond / check configuration" | ① `config/pi-settings.json` provider/model ② `config/pi-auth.json` 对应 provider 的 `type:'api_key'` 且 key 非占位 ③ 打包版密钥在 userData | `validateAuthFile` 的报错文案即原因 |
| 模型端点连不上 | 代理模式：默认环境变量；`--pi-system-proxy` 走 Windows 系统代理；`--pi-proxy=<URL>` 显式 | 企业内网常见：模型端点仅代理可达 |
| 生成细化失败 "not valid JSON" | 模型输出未含 JSON 对象（extractJsonObject 三级兜底后仍失败） | 重试或换模型；源流程保证未动 |
| 生成失败 "element library/steps too large" | 超预算（10k/60k 字符） | 拆分流程再细化 |
| 生成失败 "引用了不存在的变量" | 模型发明了变量名 | 参数保护守卫，属预期行为 |
| AI 接管按钮不出现 | 需 Test 有 fail 且无运行中回放/接管 | `#aiContinueTest` 的 canContinue 条件 |
| 接管启动报 baseUrl | provider=custom 必须在 `config/models.json` 配 baseUrl | `getTakeoverModelConfig` |
| 接管中途停止 | ① 遇不支持步骤（upload/switchTab/openTab/closeTab/script）或 userOperation ② 单步两次失败 ③ 10 分钟总预算 ④ Stop | 摘要在 aiDone 事件与 ai-takeover.json |

---

## 12. 错误码速查与调试入口

### 12.1 步骤失败错误码（`classifyError`，`engine/executor/src/errors.ts:67`）

| 码 | 含义 | 典型来源 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 元素解析失败（L1/L2 全未命中，或 AI ref 失效） | resolver `NO_MATCH`；候选过时 |
| `NOT_ACTIONABLE` | 元素在但不可交互（HIDDEN 也归此）/动作超时/手动构造 | actionability 检查、closed shadow 缺 position、upload 文件不存在 |
| `AMBIGUOUS`（detail 内） | 多命中且几何分差不足，拒绝猜测 | resolver，见 snapshot.json |
| `NAVIGATION_FAILED` | net::ERR_* / 导航超时 | 网络、startUrl 打不开（重试 2 次） |
| `EXPECT_MISMATCH` | expect/assert 轮询超时未满足 | verify.ts |
| `NO_EFFECT` | click/drag 后七类副作用信号全静默 | assertEffect |
| `DIALOG_UNEXPECTED` | manual 模式对话框未由 dialog 步骤处理 / dialogPolicy=fail | DialogManager |
| `VARIABLE_MISSING` | 模板渲染缺变量/语法错 | TemplateError |
| `BROWSER_CRASH` | 页面/浏览器崩溃断连 | crash 监听 |
| `FLOW_LOOP_LIMIT` | 分组访问超 3 次 | run.ts 组计数 |

### 12.2 日志与观测

- 主进程 stdout 前缀：`[flowlink]`（主流程告警）、`[playback:<flowId>]` / `[playback:prefix:<flowId>]`（回放逐步日志，含 `resolve:` 明细与 `effect:` 判定）、`[ai-takeover]`、`[perf]`（启动/录制/回放分段计时：`perfSinceAppStart`、`recording-session` 汇总行、`pi:runtime/pi:prompt`）。
- 渲染层 console：`[bridge]` 前缀（任务加载、事件流、回放步骤逐步打印）。
- `--dev`：主窗口 DevTools detach + 主进程 `--inspect=9229`。
- 产物即证据：失败步骤看 `artifacts/<flowId>/runs/<runId>/<idx>/{before,after}.png + snapshot.json + log.txt`；录制质量看 `flows/<id>.raw.json` 的 warnings 与事件流。

---

*文档基准：master 工作区 2026-11-17（含未提交的 pending-semantics/auto-repair 改动）。行号会随重构漂移，函数名/通道名为主要索引。*
