# 执行计划：录制改用 rrweb 真·录屏（并移除 800ms 截屏管线）

> 决策记录（2026-11-17，用户批准）：在去除闪烁（移除 `capturePage` 轮询）之外，
> 录屏从「PNG 帧拼 webm」改为 **rrweb DOM 事件录制**——真正的录屏回放，而不是
> 截屏拼凑。调查背景见 `docs/investigation-recording-flicker-step-types-instruction-takeover.md` §1。
>
> 执行约束：**不 commit、不切分支**（工作区有未提交的前期工作，全部保留）；
> 只改本计划列出的文件；验证方式 = `npm run build` + `npx tsc --noEmit`（项目惯例
> 不跑测试套件）；完成后更新 `CHANGELOG.md`。

## 0. 目标与验收标准

1. 录制期间**不再有任何周期性截图**（800ms `capturePage` 管线整体删除）→ 闪烁
   与「点击丢失」消失。
2. 录制产物包含每个标签页的 rrweb 事件流（JSONL）+ manifest；Record 标签页用
   rrweb Replayer 播放，支持多标签页切换，可拖动进度。
3. 旧录制（webm/帧目录）在 Record 标签页仍能回放（向后兼容，不迁移数据）。
4. 录制过程无主进程同步编码、无大体积周期 IPC；事件流式落盘，内存占用有界。
5. password 输入值必须被 rrweb 掩码（`maskInputOptions: { password: true }`，
   硬性安全要求，与产品的 secret 策略一致）。
6. `npm run build` + `npx tsc --noEmit` 通过。

## 1. 背景与现状（执行会话必读）

- 录制会话由主进程 `src/main.ts` 的 `recording:start` 驱动：`resetBrowserTabs` →
  `engine.pageFor` 附着各标签页得到 Playwright `Page` → `recordOnPage`（engine/recorder）
  后台录制；同一时刻主进程还开着 **800ms `setInterval` 的 `captureRecordingFrame()`**
  （`src/main.ts:410-448`：`view.webContents.capturePage()` → `toPNG()` 落盘 +
  `toDataURL()` IPC），渲染层 `renderer/bridge.js:1015-1040`（canvas+MediaRecorder
  合成 webm）与 `bridge.js:1583-1618`（帧消费）配套。**这条管线是闪烁根因，全部删除。**
- Playwright Page 获取：`src/engine-bridge.ts` `EngineBridge.pageFor(tabId, webContents)`
  （带缓存、marker 发现）；`tabIdForPage(page)` 反查 tabId。录制期间新开的标签页在
  `registerBrowserTab` 的 windowOpenHandler、`browser:createTab` IPC 里附着，push 进
  `recordingAdditionalPages`（`src/main.ts:250-265、917-930`）。
- 构建管线 `build.mjs`：main（ESM bundle）、preload（CJS）、renderer-vendor
  （IIFE 浏览器全局，`src/renderer-vendor.ts` 目前只导出 dagre）。渲染层没有打包器，
  `renderer/index.html` 原样加载 `../dist/renderer-vendor.js` + `flow-graph.js` +
  `app.js` + `bridge.js`。
- 静态资源随包分发的先例：recorder 的 `capture.js` 由主 bundle 按 `import.meta.url`
  相对路径读取。
- 录制元数据：`src/store.ts` `RecordingMeta`（`videoFile/posterFile/frames/stepScreenshots/
  captureDir`），Record 标签页渲染在 `renderer/app.js` `fillRecordPanel`（~1917-1959），
  列表缩略图用 `posterFile`。
- 录制产物清理守卫：`src/main.ts` `removeRecordingFiles`（`recording-` 前缀目录 +
  `captureDir` 白名单）。

## 2. 设计

### 2.1 依赖与构建

- `package.json` 增加 `rrweb`（^2.x，MIT）。企业代理下 npm 安装失败时报告，不要换源。
- `build.mjs` 增加两个产物：
  1. **`dist/rrweb-inject.js`**：browser IIFE，仅含 `rrweb/record`（import `{ record } from 'rrweb'`），
     暴露 `window.__flowlinkRrwebBoot()`：若 `window.top !== window` 或已在录则跳过；
     否则 `window.__flowlinkRrwebStop = record({ emit: e => window.__flowlinkRrwebEvent?.(e), maskInputOptions: { password: true }, recordCanvas: false, ... })`。
     主进程从磁盘读该文件内容（先例：capture.js），经 Playwright 注入。
  2. **renderer vendor**：`src/renderer-vendor.ts` 增加
     `import { Replayer } from 'rrweb'` → `window.__flowlinkRrweb = { Replayer }`
     （体积约 +300KB，可接受；缺失时 Record 页显示明确错误，参照 dagre 的降级处理）。

### 2.2 主进程：新增 `src/rrweb-capture.ts`，main.ts 接线

新模块职责（不塞进 main.ts）：

```ts
startRrwebRecording({ rootDir, pages: Array<{ page: Page; tabId: string }>, tabLabels })
attachRrwebPage(page, tabId)          // 录制中途新开标签页时补挂
stopRrwebRecording(): Promise<{ dir: string; tabCount: number; eventCount: number }>
```

- 每页：`page.exposeBinding('__flowlinkRrwebEvent', (source, event) => ...)`（先注册，
  跨导航持久）→ `page.addInitScript(injectJs)`（跨导航自动重启录制器）→
  `page.evaluate(injectJs + '; window.__flowlinkRrwebBoot()')`（当前已加载文档立即生效）。
- 事件落盘：`rootDir/record/rrweb/<tabId>.jsonl`（每行一个事件 JSON，含注入时间戳），
  **流式 append，不驻留内存**；`rootDir/record/rrweb/manifest.json` 记
  `{ startedAt, tabs: [{ tabId, label, file, events }], activations: [{ ts, tabId }] }`。
- 标签页激活时间线：`main.ts` 现有的 `tabActivated` host event 入口
  （`browser:switchTab`，`src/main.ts:938`）处同时推给 rrweb 模块记 activation。
- 停止：对所有已挂页面 `page.evaluate('window.__flowlinkRrwebStop?.()')`（尽力而为，
  页面已销毁则跳过），flush 后写终版 manifest。
- `rootDir` 复用旧 capture 的目录策略：`artifactsRoot/recording-<ts>/`（保持
  `removeRecordingFiles` 的 `recording-` 前缀清理守卫直接兼容，挂到 `RecordingMeta.captureDir`）。

`src/main.ts` 改动：

- **删除** `captureRecordingFrame` / `startRecordingCapture` / `stopRecordingCapture`
  与 `recordingCaptureTimer/Frames/Busy/Active` 状态（`src/main.ts:64-69、409-475`）。
- `recording:start`：page 附着完成后调用 `startRrwebRecording`（seed pages + 当前
  browserViews），并**一次性** `capturePage()` 取 poster（单次截图无闪烁问题；
  posterFile 兼容列表缩略图）。取消路径（`discardEmptyRecordingCapture`）改为
  rrweb 目录的同样清理逻辑。
- 新标签页附着点（windowOpenHandler / `browser:createTab`）在录制期间调用
  `attachRrwebPage`。
- `stopRecordingSession`：`stopRrwebRecording()` 结果写进 `RecordingMeta`
  （新增 `rrwebDir?: string`，`src/store.ts` 加可选字段；`frames` 不再产出，字段保留
  兼容旧数据）。
- 新 IPC `recording:loadRrweb(dir)`：读 manifest + 各 jsonl（返回前 gzip 解压不需要；
  v1 原样返回），渲染端 Replayer 用。preload 若白名单了 IPC 频道则同步补
  （先查 `src/preload.ts` 的暴露方式）。
- `recording:saveVideo` IPC 与渲染端 webm 管线一并删除（旧 webm 文件的回放走
  静态 file:// URL，不依赖该 IPC）。

### 2.3 渲染层：Record 标签页改 rrweb 播放器

- `renderer/bridge.js`：删除 `startRecordingMedia` / `stopRecordingMedia` /
  `recording:captureFrame` 消费（1583-1618）、stop 流程里的 saveVideo 调用
  （638-649 相关分支）；`media` 组装保留 `videoURL/posterFile`（旧数据）并新增
  `rrwebDir`。
- `renderer/app.js` `fillRecordPanel`：优先级 **rrwebDir → 播放器**；无 rrwebDir 时保持
  现状（video/poster/截图墙），旧录制不受影响。
- 新播放器（纯渲染层，无框架）：
  - `recording:loadRrweb` 拉取 manifest+事件；每个 tab 一个 `rrweb.Replayer` 实例
    挂到各自容器，`player.goto(0)` 后由统一时间轴驱动（Replayer 支持
    `play/pause/goto`；多实例由主时钟同步：定时器推进当前 ts，按 activation 时间线
    切换显示的 tab 容器）。
  - 控件：播放/暂停、进度条（映射到总时长）、各 tab 按钮（手动切换即暂停自动跟随）。
  - 事件解析失败/Replayer 缺失（vendor 未构建）→ 显示明确错误信息块。

### 2.4 已知限制（写进 CHANGELOG 与计划备案，不算缺陷）

- 跨域 iframe、canvas/WebGL 内容不在录制内（`recordCanvas:false`；后续可开）；
  closed shadow DOM 内部变更不可观测（与引擎已知的 closed shadow 处理一致）。
- password 输入值掩码；其余输入值明文录制（便于人工核对），后续可加全局掩码开关。

## 3. 实施步骤（建议顺序）

1. 安装依赖 + build.mjs 两个新产物（注入 bundle、vendor 扩展）。
2. `src/rrweb-capture.ts` 模块 + 单元可测的纯函数（manifest 结构、jsonl append）。
3. `src/main.ts` 接线与旧管线删除；`src/store.ts` 字段；`src/preload.ts` 如需。
4. `renderer/bridge.js` 旧管线删除 + `media.rrwebDir`。
5. `renderer/app.js` + `renderer/index.html` + `renderer/app.css`：Record 播放器。
6. `CHANGELOG.md` 更新；`npm run build` + `npx tsc --noEmit` 收尾。

## 4. 风险与回退

- rrweb 注入被个别站点的页面逻辑干扰（少见；CDP 注入不受页面 CSP 限制）→ 记录在
  CHANGELOG，保留旧 stepScreenshots 证据链不受影响（recorder 每步截图**保留不动**）。
- 多导航场景：每次导航 = 新 full snapshot，Replayer 天然支持拼接流（多 Meta/
  FullSnapshot 对），无需特殊处理。
- 事件量异常（极端单页应用）→ jsonl 分文件按 tab 隔离；如需 gzip 后置优化，不在
  本次范围。
