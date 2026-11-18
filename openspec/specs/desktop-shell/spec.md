# Desktop Shell Specification

## Purpose

Electron 桌面壳契约：安全边界（preload 窗口 API）、内嵌浏览器与原生视图管理、CDP 映射、任务持久化、单活动会话编排与非阻塞启动。Flow 动作语义与元素匹配算法不属于本能力。

## Requirements

### Requirement: The renderer SHALL reach Node and Electron capabilities only through the narrow preload API

The renderer SHALL reach Node and Electron capabilities only through the narrow `window.flowlink` preload API.

渲染窗口启用 `contextIsolation`、禁用 `nodeIntegration`；操作按 `tasks` / `processLandscape` / `recording` / `playback` / `pi` / `flow` / `browser` 分组，invoke 映射到具名 `ipcMain.handle` 处理器；订阅仅限固定的事件通道白名单并返回取消订阅回调。渲染代码不得引入 `require`、Node/Electron 导入或直接文件系统访问。

#### Scenario: 白名单订阅
- **WHEN** 渲染层订阅一个事件
- **THEN** 只能通过 allow-list 中的通道订阅，并拿到 unsubscribe 回调

### Requirement: The embedded browser SHALL be a sandboxed WebContentsView positioned by renderer-reported bounds

The embedded browser SHALL be a sandboxed `WebContentsView` positioned by renderer-reported bounds, with one explicit owner of native visibility.

渲染层上报浏览器表面的 DOM 矩形（ResizeObserver 之外，每次工作区渲染还强制 RAF+短延迟上报占位矩形并经 bounds 缓存去重，覆盖观察器漏掉的布局变化如 AI 面板关闭）；主进程把原生视图移动/显示到该矩形。可见性与 `webContents.isLoading()` 无关：只有选中的视图可在表面启用且有可用 bounds 时显示；页面加载不控制可见性，避免导航与对话框期间空白或意外暴露。工作区确认对话框临时隐藏原生视图，之后按上报 bounds 恢复。

#### Scenario: 导航不闪白
- **WHEN** 内嵌浏览器正在导航
- **THEN** 视图可见性不因加载状态变化而闪烁

#### Scenario: 面板关闭回收宽度
- **WHEN** 用户关闭 AI 面板
- **THEN** 浏览器表面重新占满剩余宽度，原生视图对齐新矩形

### Requirement: Navigation SHALL be normalized and restricted to HTTP/HTTPS in the main process

Navigation SHALL be normalized and restricted to HTTP/HTTPS in the main process.

新窗口请求转换为原生浏览器标签页而非放任独立未管理窗口；回放的标签页创建走原生视图工厂（`openPage`），不调用 CDP `Target.createTarget`。

#### Scenario: 新窗口请求
- **WHEN** 页面尝试打开新窗口
- **THEN** 以新的原生标签页承载

### Requirement: EngineBridge SHALL map native tabs to Playwright Pages by tab markers over CDP

EngineBridge SHALL map native tabs to Playwright Pages by tab-specific markers over CDP.

Electron 以 `--remote-debugging-port=0` 启动，等待 `DevToolsActivePort` 文件后经 `connectOverCDP` 连接 127.0.0.1。映射先向标签页 webContents 写入 tab 专属标记再在页面中查找（强于 URL 匹配，因为独立标签页可以同源），CDP target-ID 比较为回退；发现过程有界重试（WebContents 创建与 CDP target 发布是异步的）；映射被缓存并在标签页关闭或标签页集合重置时显式遗忘。

#### Scenario: 同源多标签页区分
- **WHEN** 两个标签页打开同一 URL
- **THEN** 标记机制仍能把各自映射到正确的 Playwright Page

### Requirement: TaskStore SHALL persist tasks.json atomically with lazy hydration and cascading deletes

TaskStore SHALL persist `tasks.json` atomically, hydrate lazily, and cascade deletes across a recording's files.

写入采用临时兄弟文件 + 改名，避免目标处出现半截 JSON；首次加载时缺失或非法的任务 JSON 视为空库以保启动，后续写失败不被静默转为成功持久化。启动只加载任务元数据与录制计数；任务抽屉打开时才水合该任务的录制元数据与已存 Flow 详情。删除一条录制移除其 Flow JSON、全部录制工件与会话捕获文件；删除任务移除其所有录制的上述文件；关闭未保存的新任务流丢弃其草稿下创建的录制。临时 UI 状态（打开的页签、焦点、面板尺寸）有意不恢复。

#### Scenario: 损坏任务文件
- **WHEN** tasks.json 缺失或非法
- **THEN** 以空任务库启动，不阻塞

#### Scenario: 删除级联
- **WHEN** 删除一条录制
- **THEN** 其 Flow 与工件目录一并移除

### Requirement: Recording and playback SHALL be single active operations with serialized lifecycle transitions

Recording and playback SHALL be single active operations in the main process with serialized lifecycle transitions.

Promise 跟踪活动中的启动/停止/录制/回放，abort 控制器中断可取消工作；Stop 与浏览器重启共享同一条录制清理路径，防止并发请求重复保存或删除同一输出。每次进入 Test 先串行完成一次 stop/reset 操作再替换视图；`browser:restart` 等待在途 stop 后替换视图，留一个全新起始 URL 标签页；回放进行中在进程边界拒绝重启。为录制或 Test 打开内嵌浏览器始终是全新浏览器会话——多余标签页关闭、起始 URL 无条件重载；空闲时打开任务流工作区把浏览器重置到该流起始 URL，标签页与页面状态不跨任务流/运行泄漏。测试入口拒绝不属于当前会话的录制。

#### Scenario: 旧录制不泄漏进 Test
- **WHEN** 上一录制会话尚未完全停止就点击 Test
- **THEN** 先完成停止/重置，再开始本次运行

#### Scenario: 起始页不陈旧
- **WHEN** 上次运行结束时浏览器停在起始 URL 上，再次运行同一 Flow
- **THEN** 预运行重置重新加载起始页；首个可执行步骤为 navigate 时重置不自行加载、由该步导航作为唯一在途加载，navigate 步骤失败重试一次

### Requirement: Recording start SHALL preserve the current page when already on the start URL

Recording start SHALL preserve the current page when the browser is already on the start URL.

判定为 origin/path/query 相等、忽略 hash——录制基线是当前 DOM（与 `preservePage` 语义一致）；需要全新页面时用户先用浏览器工具栏刷新。`browser:restart` 是完整重置：清除附着缓存并在后台重新预热。

#### Scenario: 已在起始页
- **WHEN** 浏览器停在起始 URL 时开始录制
- **THEN** 不发生导航重载，直接开始采集

### Requirement: Startup SHALL not block on external networks or engine initialization

Startup SHALL not block on external networks or engine initialization.

渲染窗口在本地 HTML 加载后即显示，初始浏览器 URL 异步加载。CDP 附着在启动后后台预热且失败不阻塞启动（录制启动保留自己的引擎守卫）；`playwright-core` 首次附着时动态导入而非启动期加载。Pi 运行时懒生成但预热：窗口显示约 1.5 秒后或 AI 面板打开时（`pi:prewarm`）导入 SDK 并填充运行时缓存、不联系 provider。应用经 `scripts/start.mjs` 纯 Node 脚本拉起（支持 `--dev`、`--pi-system-proxy`、`--pi-proxy`，兼容旧拼写），启动器把 Windows 控制台切 UTF-8 代码页。

#### Scenario: 无网启动
- **WHEN** 在受限网络下启动应用
- **THEN** 主窗口照常显示，浏览器初始 URL 在后台加载

### Requirement: Generated identifiers and artifact paths SHALL be sanitized and contained

Generated identifiers and artifact paths SHALL be sanitized and kept inside their intended roots.

流/运行标识符、文件名与生成的目录段经过 `sanitizeSegment`；回放写入器强制解析后的文件保持在运行目录内；下载与 crop 必须留在其工件/输出根之下。

#### Scenario: 路径遏制
- **WHEN** 工件写入解析到运行目录之外
- **THEN** 写入被拒绝
