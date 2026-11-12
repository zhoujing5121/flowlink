/**
 * FlowLink 主进程。
 *
 * 职责：
 * 1. 创建 BrowserWindow（加载 renderer/index.html，挂 preload）
 * 2. 创建 WebContentsView 作为内嵌浏览器，按渲染进程上报的 #browserFrames 矩形定位
 * 3. 以 --remote-debugging-port=0 启动，EngineBridge 通过 CDP 附着 Playwright 到内嵌浏览器
 * 4. IPC：任务 CRUD、录制启停（recordOnPage）、回放（playOnPage）、导航、视图定位
 *
 * esbuild 直接打包本地 TS 源码；capture.js 作为 engine 下的静态资源随包分发。
 */
import { app, BrowserWindow, ipcMain, WebContentsView } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { TaskStore, type RecordingMeta, type TaskProfilePatch } from './store.js'
import { EngineBridge } from './engine-bridge.js'
import { disposePiWorker, piStatus, prewarmPi, runPiPrompt, isAutoRefineEnabled } from './pi-agent.js'
import { perf, perfSinceAppStart } from './perf.js'
import { generateRefinedFlow } from './ai-refine.js'
import { EmptyRecordingError, recordOnPage, writeFlowForgeArchive, resolveSystem, type CaptureTab, type HostCaptureEvent, type RecordResult } from '../engine/recorder/src/index.js'
import { flattenSteps, playOnPage, prefixSteps, type RunResult } from '../engine/executor/src/index.js'
import { loadFlow, parseFlow, saveFlow, makeId } from '../engine/schema/src/index.js'
import type { Flow } from '../engine/schema/src/index.js'
import type { Page } from 'playwright-core'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* Electron CDP：Playwright connectOverCDP 的前提 */
app.commandLine.appendSwitch('remote-debugging-port', '0')

/**
 * 主进程协调状态：Electron 持有原生浏览器视图及其显隐状态；渲染进程只
 * 能通过受限的 IPC 桥请求操作，页面执行与数据持久化仍由主进程和引擎负责。
 * 录制与回放同一时刻各自只允许一个会话；下方 Promise 与控制器用于串联
 * Stop、重启和应用退出，确保这些入口最终汇合到一致的清理流程。
 */
let mainWindow: BrowserWindow
let browserView: WebContentsView
const browserViews = new Map<string, WebContentsView>()
const browserBounds = { x: 0, y: 0, width: 1, height: 1 }
let browserBoundsTimer: ReturnType<typeof setTimeout> | null = null
let activeBrowserTabId = 'browser'
let browserSurfaceVisible = false
let taskStore: TaskStore
let engine: EngineBridge
let artifactsRoot = ''
let flowsRoot = ''

/* ---------------- 录制会话状态 ---------------- */
let recController: AbortController | null = null
let recStartPromise: Promise<{ ok: boolean; reason?: string }> | null = null
let recStopPromise: Promise<RecordingStopResult> | null = null
let recPromise: Promise<RecordResult> | null = null
let recStopRequested = false
let recTaskCode = ''
let recOutPath = ''
let recordingCaptureTimer: ReturnType<typeof setInterval> | null = null
let recordingCaptureRoot = ''
let recordingCaptureDir = ''
let recordingCaptureFrames: string[] = []
let recordingAdditionalPages: Page[] = []
let recordingTabIds: string[] = []
const recordingTabSnapshots = new Map<string, { url: string; title: string }>()
let recordingHostEvents: HostCaptureEvent[] = []

/* ---------------- 回放会话状态 ---------------- */
let playPromise: Promise<RunResult> | null = null
let playAbortController: AbortController | null = null
const pendingUserOperationWaits = new Map<string, () => void>()

/* ================================================================ */
/* 启动                                                              */
/* ================================================================ */

/** 生成便于用户识别的每日名称；Flow 持久化 ID 仍负责保证唯一性。 */
function generatedRecordingName(): string {
	const now = new Date()
	const mm = String(now.getMonth() + 1).padStart(2, '0')
	const dd = String(now.getDate()).padStart(2, '0')
	const hh = String(now.getHours()).padStart(2, '0')
	const min = String(now.getMinutes()).padStart(2, '0')
	return `RECORD-${mm}${dd}-${hh}${min}`
}

function isEmptyRecordingError(error: unknown): boolean {
	return (
		error instanceof EmptyRecordingError ||
		(error instanceof Error && error.name === 'EmptyRecordingError')
	)
}

/** 将主动取消与启动失败区分开，避免把正常取消作为错误上报。 */
class RecordingStartCancelledError extends Error {
	constructor() {
		super('录制启动已取消')
		this.name = 'RecordingStartCancelledError'
	}
}

/** 让不可控的导航/CDP 等待响应 Stop；底层 Promise 的后续结果会被安全忽略。 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new RecordingStartCancelledError())
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', onAbort)
		const onAbort = () => {
			cleanup()
			reject(new RecordingStartCancelledError())
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				cleanup()
				resolve(value)
			},
			(error) => {
				cleanup()
				reject(error)
			},
		)
	})
}

function resetRecordingState(): void {
	recController = null
	recPromise = null
	recTaskCode = ''
	recOutPath = ''
	recordingCaptureRoot = ''
	recordingCaptureDir = ''
	recordingCaptureFrames = []
	recordingAdditionalPages = []
	recordingTabIds = []
	recordingTabSnapshots.clear()
	recordingHostEvents = []
	recStopRequested = false
}

function managedDirectChild(root: string, targetPath: string, description: string): string {
	const target = resolve(targetPath)
	const rel = relative(resolve(root), target)
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(sep)) {
		throw new Error(`Refusing to remove ${description} outside its managed directory`)
	}
	return target
}

async function removeRecordingFiles(recording: RecordingMeta): Promise<void> {
	const directories = new Set<string>()
	const files = new Set<string>()
	const artifactDir = managedDirectChild(artifactsRoot, recording.artifactsDir, 'recording artifacts')
	if (basename(artifactDir) !== recording.id) {
		throw new Error('Refusing to remove recording artifacts with a mismatched ID')
	}
	directories.add(artifactDir)

	const flowFile = managedDirectChild(flowsRoot, recording.flowFile, 'Flow file')
	if (!/^(?:\d+-[\w-]+|recording-[\w-]+)\.json$/i.test(basename(flowFile))) {
		throw new Error('Refusing to remove a Flow file with an invalid generated name')
	}
	files.add(flowFile)
	files.add(`${flowFile}.bak`)
	files.add(flowFile.replace(/\.json$/i, '.raw.json'))

	const captureDirs = [recording.captureDir].filter((path): path is string => !!path)
	for (const frame of recording.frames ?? []) {
		const framePath = resolve(frame)
		const rel = relative(resolve(artifactsRoot), framePath)
		const parts = rel.split(sep)
		if (
			parts.length === 4 &&
			parts[0].startsWith('recording-') &&
			parts[1] === 'record' &&
			parts[2] === 'video' &&
			/^frame-\d+\.png$/i.test(parts[3])
		) {
			captureDirs.push(join(artifactsRoot, parts[0]))
		}
	}
	for (const captureDir of new Set(captureDirs)) {
		const managedDir = managedDirectChild(artifactsRoot, captureDir, 'recording capture')
		if (!basename(managedDir).startsWith('recording-')) {
			throw new Error('Refusing to remove an invalid recording capture directory')
		}
		directories.add(managedDir)
	}

	for (const directory of directories) await rm(directory, { recursive: true, force: true })
	for (const file of files) await rm(file, { force: true })
}

/** 启动被取消或没有记录到步骤时，清理本次会话产生的临时捕获文件。 */
async function discardEmptyRecordingCapture(): Promise<void> {
	await stopRecordingCapture().catch(() => undefined)
	// 只删除本次会话生成的独立目录，不触碰其它录制。
	if (recordingCaptureRoot) {
		await rm(recordingCaptureRoot, { recursive: true, force: true }).catch(() => undefined)
	}
}

function syncBrowserVisibility(): void {
	// 只有当前活动标签页、界面已启用且布局尺寸有效时才显示原生视图。
	// 是否正在加载不参与判断，避免页面导航时视图闪烁或错误显露。
	for (const view of browserViews.values()) {
		if (view.webContents.isDestroyed()) continue
		const visible =
			view === browserView &&
			browserSurfaceVisible &&
			browserBounds.width > 1 &&
			browserBounds.height > 1
		view.setVisible(visible)
	}
}

function registerBrowserTab(tabId: string, view: WebContentsView): void {
	// 每个原生标签页都单独转发状态事件，而非只监听启动时的活动页；
	// 这样切换到后台标签页时，地址栏和加载状态也能保持同步。
	browserViews.set(tabId, view)
	if ((recStartPromise || recPromise) && !recordingTabIds.includes(tabId)) {
		recordingTabIds.push(tabId)
		recordingHostEvents.push({ action: 'tabCreated', ts: Date.now(), tabId, url: view.webContents.getURL(), title: view.webContents.getTitle() })
	}
	const forward = (url: string): void => {
		if (recordingTabIds.includes(tabId)) recordingTabSnapshots.set(tabId, { url, title: view.webContents.getTitle() })
		if (!mainWindow.isDestroyed())
			mainWindow.webContents.send('browser:urlChanged', { url, tabId })
	}
	view.webContents.on('did-navigate', (_event, url) => forward(url))
	view.webContents.on('did-navigate-in-page', (_event, url) => forward(url))
	view.webContents.on('will-redirect', (_event, url, _isInPlace, isMainFrame) => {
		if (isMainFrame && (recPromise || recStartPromise)) recordingHostEvents.push({ action: 'autoRedirect', ts: Date.now(), tabId, url, title: view.webContents.getTitle(), previousUrl: view.webContents.getURL() })
	})
	view.webContents.on('did-start-loading', () => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('browser:loading', { loading: true, tabId })
	})
	view.webContents.on('did-stop-loading', () => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('browser:loading', { loading: false, tabId })
		syncBrowserVisibility()
	})
	view.webContents.setWindowOpenHandler(({ url }) => {
		const tabId = `tab-${Date.now()}-${browserViews.size}`
		const opened = createBrowserTab(tabId, url)
		browserView.setVisible(false)
		browserView = opened
		activeBrowserTabId = tabId
		mainWindow.webContents.send('browser:tabOpened', { tabId, url })
		if ((recPromise || playPromise) && engine) {
			void engine.pageFor(tabId, opened.webContents).then((page) => {
				if (!recordingAdditionalPages.includes(page)) recordingAdditionalPages.push(page)
			}).catch((err) => {
				console.warn(`[flowlink] popup 标签页录制附着失败：`, (err as Error).message)
			})
		}
		return { action: 'deny' }
	})
}

function createBrowserTab(tabId: string, initialUrl = 'https://bosch.com.cn'): WebContentsView {
	const view = new WebContentsView({ webPreferences: { sandbox: true } })
	mainWindow.contentView.addChildView(view)
	view.setBounds(browserBounds)
	view.setVisible(false)
	registerBrowserTab(tabId, view)
	if (initialUrl) void view.webContents.loadURL(initialUrl).catch(() => {})
	return view
}

/** 创建原生浏览器标签页并立即切到它（用于回放 openTab），不等待 Playwright 附着。 */
function createNativeBrowserTab(tabId: string, url: string, activate: boolean): WebContentsView {
	const previousView = browserView
	const view = createBrowserTab(tabId, url || 'about:blank')
	if (activate) {
		previousView?.setVisible(false)
		browserView = view
		activeBrowserTabId = tabId
		browserSurfaceVisible = true
		ensureBrowserBounds()
		syncBrowserVisibility()
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send('browser:tabOpened', { tabId, url, active: true })
		}
	}
	return view
}

function normalizeHttpUrl(value: string): string {
	const input = String(value || '').trim()
	let normalized = input
	if (!/^https?:\/\//i.test(normalized)) {
		const usesLocalHttp = /^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(normalized)
		normalized = `${usesLocalHttp ? 'http' : 'https'}://${normalized}`
	}
	let parsed: URL
	try {
		parsed = new URL(normalized)
	} catch {
		throw new Error('请输入有效的网址')
	}
	if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
		throw new Error('只支持 http 或 https 网址')
	}
	return parsed.href
}

/** origin+path+query 相同（忽略 hash）即视为同一页面，无需重新导航。 */
function samePageUrl(a: string, b: string): boolean {
	try {
		const ua = new URL(a)
		const ub = new URL(b)
		return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search
	} catch {
		return false
	}
}

/** 模式切换前把内嵌浏览器还原到单一 start-URL 标签页；cookie/storage/cache 保留。 */
async function resetBrowserTabs(initialUrl: string): Promise<void> {
	// 销毁旧页面前先等待正在进行的会话收尾，避免迟到的异步回调附着到
	// 新标签页集合，或意外修改刚重建的浏览器状态。
	// 销毁旧页面前先等待正在进行的会话收尾，避免迟到的异步回调附着到
	// 新标签页集合，或意外修改刚重建的浏览器状态。
	if (recStopPromise) await recStopPromise.catch(() => undefined)
	if (playPromise) await playPromise.catch(() => undefined)

	for (const [tabId, view] of browserViews) {
		if (view === browserView) continue
		mainWindow.contentView.removeChildView(view)
		if (!view.webContents.isDestroyed()) view.webContents.close()
		engine?.forget(tabId)
	}
	browserViews.clear()
	recordingAdditionalPages = []
	// 上面的销毁循环已逐个 forget；主标签页未被销毁，其缓存的 Playwright
	// Page 在 loadURL 导航后依然有效（CDP target 不变），保留它让 Record 点击
	// 时 pageFor 直接命中缓存。完整重置（browser:restart）单独调用 forgetAll。

	activeBrowserTabId = 'browser'
	if (!browserView || browserView.webContents.isDestroyed()) {
		browserView = new WebContentsView({ webPreferences: { sandbox: true } })
		browserViews.set(activeBrowserTabId, browserView)
		mainWindow.contentView.addChildView(browserView)
	} else {
		browserViews.set(activeBrowserTabId, browserView)
	}
	browserView.setBounds(browserBounds)
	browserView.setVisible(false)
	browserSurfaceVisible = false
	syncBrowserVisibility()

	const startUrl = initialUrl || 'https://bosch.com.cn'
	// 跳过重载意味着录制基线是当前 DOM 而非新加载页面（与 preservePage 同
	// 一取舍）。若将来需要保证干净基线，应做成显式的「录制前强制刷新」选项，
	// 而不是恢复这里的无条件 loadURL；recorder 本就把已存在的页面当作种子
	// 上下文（无初始导航事件）。
	if (samePageUrl(browserView.webContents.getURL(), startUrl)) return
	// 导航后台进行，不再二次等待整页加载：recorder 的 waitForLoadState('load')
	// 是唯一加载闸门，回放路径的执行器 goto 同理；Stop 仍经 webContents.stop()
	// 与 withAbort 立即中止。
	void browserView.webContents.loadURL(startUrl).catch(() => {})
}

/** Electron 回放专用开页工厂：禁止走 Playwright Target.createTarget。 */
function createNativePlaybackPage(
	activate: boolean,
	log: (msg: string) => void = () => {},
): (url?: string) => Promise<Page> {
	return async (url?: string): Promise<Page> => {
		// Electron 原生标签页是唯一事实来源；只有 CDP 能发现对应的
		// WebContentsView 后，才把 Playwright Page 交给执行器继续回放。
		const targetUrl = url && url !== 'about:blank' ? normalizeHttpUrl(url) : undefined
		const tabId = `tab-${Date.now()}-${browserViews.size}`
		const previousView = browserView
		const previousTabId = activeBrowserTabId
		log(`openPage: creating native tab ${tabId}${targetUrl ? ` for ${targetUrl}` : ''}`)
		const view = createNativeBrowserTab(tabId, targetUrl || 'about:blank', activate)
		try {
			const page = await engine.pageFor(tabId, view.webContents)
			log(`openPage: Playwright attached to ${tabId}`)
			return page
		} catch (err) {
			log(`openPage: failed for ${tabId}: ${(err as Error).message}`)
			browserViews.delete(tabId)
			engine?.forget(tabId)
			mainWindow.contentView.removeChildView(view)
			if (!view.webContents.isDestroyed()) view.webContents.close()
			if (browserView === view) {
				browserView = previousView
				activeBrowserTabId = previousTabId
				syncBrowserVisibility()
			}
			throw err
		}
	}
}

/** 回放期间浏览器 surface 尚未上报有效 bounds 时，用主窗口内容区兜底，避免新标签页不可见。 */
function ensureBrowserBounds(): void {
	if (browserBounds.width > 1 && browserBounds.height > 1) return
	if (mainWindow?.isDestroyed()) return
	const content = mainWindow.getContentBounds()
	browserBounds.x = 0
	browserBounds.y = 0
	browserBounds.width = Math.max(320, Math.round(content.width * 0.75))
	browserBounds.height = Math.max(240, Math.round(content.height * 0.75))
	for (const view of browserViews.values()) {
		if (view.webContents.isDestroyed()) continue
		view.setBounds(browserBounds)
	}
}

async function startRecordingCapture(flowId: string): Promise<void> {
	recordingCaptureRoot = join(artifactsRoot, flowId)
	recordingCaptureDir = join(recordingCaptureRoot, 'record', 'video')
	recordingCaptureFrames = []
	await mkdir(recordingCaptureDir, { recursive: true })
	let capturing = false
	recordingCaptureTimer = setInterval(() => {
		// 截图和磁盘写入较慢时也不排队启动下一次捕获，避免积压任务并
		// 保证帧的写入顺序与实际采集顺序一致。
		if (capturing || browserViews.size === 0) return
		capturing = true
		const view = browserView
		const tabId = activeBrowserTabId
		view.webContents
			.capturePage()
			.then(async (image) => {
				const png = image.toPNG()
				if (!png.length) return
				const framePath = join(recordingCaptureDir, `frame-${String(recordingCaptureFrames.length + 1).padStart(4, '0')}.png`)
				await writeFile(framePath, png)
				recordingCaptureFrames.push(framePath)
				if (!mainWindow.isDestroyed()) {
					mainWindow.webContents.send('recording:captureFrame', {
						dataUrl: image.toDataURL(),
						index: recordingCaptureFrames.length,
						tabId,
						url: view.webContents.getURL(),
					})
				}
			})
			.catch(() => {})
			.finally(() => {
				capturing = false
			})
	}, 800)
}

async function stopRecordingCapture(): Promise<{ frames: string[]; poster: string }> {
	if (recordingCaptureTimer) {
		clearInterval(recordingCaptureTimer)
		recordingCaptureTimer = null
	}
	await sleep(850)
	return {
		frames: [...recordingCaptureFrames],
		poster: recordingCaptureFrames[0] ?? '',
	}
}

/** 有界轮询 Electron 异步生成的端口文件，超时后明确报告启动失败。 */
async function waitForCdpPort(userDataDir: string): Promise<number> {
	for (let attempt = 0; attempt < 80; attempt++) {
		try {
			const raw = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')
			const port = Number(raw.split('\n')[0]?.trim())
			if (Number.isInteger(port) && port > 0) return port
		} catch {
			/* 文件还没写出来 */
		}
		await sleep(100)
	}
	throw new Error('CDP 端口未就绪：DevToolsActivePort 文件在 8 秒内未出现')
}

app.whenReady().then(async () => {
	perfSinceAppStart('startup:whenReady')
	// 先创建持久化目录，再注册可能写入这些目录的操作；随后等待 Electron
	// 分配并写入随机 CDP 端口，以便引擎桥接建立连接。
	const userData = app.getPath('userData')
	artifactsRoot = join(userData, 'flowlink', 'artifacts')
	flowsRoot = join(userData, 'flowlink', 'flows')
	await mkdir(artifactsRoot, { recursive: true })
	await mkdir(flowsRoot, { recursive: true })

	taskStore = new TaskStore(join(userData, 'flowlink', 'tasks.json'))

	registerIpc()
	await createWindow()

	/* CDP 端口就绪后再建 EngineBridge（避免 pageFor 时端口还没写出来） */
	try {
		await waitForCdpPort(userData)
		engine = new EngineBridge(userData)
		// 预热 CDP 附着与页面标记发现：后台进行，失败绝不阻塞或搞挂启动；
		// recording:start 的「引擎未就绪」守卫保持不变。
		void engine.pageFor(activeBrowserTabId, browserView.webContents).catch(() => {})
	} catch (err) {
		console.error('[flowlink] EngineBridge 初始化失败：', (err as Error).message)
	}

})

app.on('window-all-closed', () => {
	if (recController) recController.abort()
	app.quit()
})

app.on('before-quit', () => disposePiWorker())

/* ================================================================ */
/* 窗口 + 内嵌浏览器                                                  */
/* ================================================================ */

async function createWindow(): Promise<void> {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1100,
		minHeight: 700,
		show: false,
		title: 'FlowLink',
		icon: join(app.getAppPath(), 'resources', 'icon.ico'),
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	})

	/* 浏览器直接嵌入主窗口内容区，不另建操作系统级子窗口。 */
	browserView = new WebContentsView({
		webPreferences: { sandbox: true },
	})
	browserViews.set(activeBrowserTabId, browserView)
	mainWindow.contentView.addChildView(browserView)
	browserView.setBounds({ x: 0, y: 0, width: 1, height: 1 })
	browserView.setVisible(false)

	/* URL 变化转发给渲染进程（地址栏同步） */
	const fwd = (url: string): void => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('browser:urlChanged', { url, tabId: activeBrowserTabId })
	}
	browserView.webContents.on('did-navigate', (_e, url: string) => fwd(url))
	browserView.webContents.on('did-navigate-in-page', (_e, url: string) => fwd(url))
	browserView.webContents.on('will-redirect', (_event, url, _isInPlace, isMainFrame) => {
		if (isMainFrame && (recPromise || recStartPromise)) recordingHostEvents.push({ action: 'autoRedirect', ts: Date.now(), tabId: activeBrowserTabId, url, title: browserView.webContents.getTitle(), previousUrl: browserView.webContents.getURL() })
	})
	browserView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		if (!isMainFrame || errorCode === -3) return
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send('browser:error', { errorCode, errorDescription, url: validatedURL })
		}
	})
	browserView.webContents.on('did-start-loading', () => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('browser:loading', { loading: true })
	})
	browserView.webContents.on('did-stop-loading', () => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('browser:loading', { loading: false })
		syncBrowserVisibility()
	})

	/* 外链点击在内嵌浏览器里打开，不另起窗口 */
	browserView.webContents.setWindowOpenHandler(({ url }) => {
		const tabId = `tab-${Date.now()}-${browserViews.size}`
		const opened = createBrowserTab(tabId, url)
		browserView.setVisible(false)
		browserView = opened
		activeBrowserTabId = tabId
		mainWindow.webContents.send('browser:tabOpened', { tabId, url })
		if ((recPromise || playPromise) && engine) {
			void engine.pageFor(tabId, opened.webContents).then((page) => {
				if (!recordingAdditionalPages.includes(page)) recordingAdditionalPages.push(page)
			}).catch((err) => {
				console.warn(`[flowlink] popup 标签页录制附着失败：`, (err as Error).message)
			})
		}
		return { action: 'deny' }
	})

	await mainWindow.loadFile(join(app.getAppPath(), 'renderer', 'index.html'))
	perfSinceAppStart('startup:loadFile-done')
	mainWindow.show()
	perfSinceAppStart('startup:shown')
	// 窗口出现后约 1.5s 的空闲里预热 Pi（SDK 导入 + 运行时缓存）；
	// AI 面板打开时渲染层也会经 pi:prewarm 触发，先到先得，重复调用是无害空转。
	setTimeout(() => void prewarmPi().catch(() => {}), 1500)

	// Don't make the first browser page's network response block the app window.
	try {
		void browserView.webContents.loadURL('https://bosch.com.cn').catch((err) => {
			console.error('[flowlink] 初始页面加载失败：', (err as Error).message)
		})
	} catch (err) {
		console.error('[flowlink] 初始页面加载失败：', (err as Error).message)
	}

	if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
		mainWindow.webContents.openDevTools({ mode: 'detach' })
	}
}

/* ================================================================ */
/* IPC                                                              */
/* ================================================================ */

interface RecordingStopResult {
	recording: RecordingMeta | null
	reason?: string
	error?: string
}

/** 把（已通过 schema 校验的）细化 Flow 保存为一条全新的 isMerged 录制；永不覆盖已有录制。 */
async function persistMergedFlow(taskCode: string, flow: Flow, name: string): Promise<RecordingMeta> {
	const recordingId = makeId('recording')
	const artifactsDir = join(artifactsRoot, recordingId)
	const flowFile = join(flowsRoot, `${recordingId}.json`)
	await mkdir(artifactsDir, { recursive: true })
	await saveFlow(flow, flowFile)
	const recording: RecordingMeta = {
		id: recordingId,
		name,
		flowFile,
		artifactsDir,
		createdAt: new Date().toISOString(),
		steps: flow.steps.length,
		posterFile: '',
		frames: [],
		stepScreenshots: [],
		isMerged: true,
	}
	await taskStore.addRecording(taskCode, recording)
	return recording
}

/** REFINED-MMDD-HHmm 使用细化生成时刻的时间；重名追加 (2)/(3)。 */
function refinedRecordingName(_sourceName: string, existingNames: Set<string>): string {
	const now = new Date()
	const mm = String(now.getMonth() + 1).padStart(2, '0')
	const dd = String(now.getDate()).padStart(2, '0')
	const hh = String(now.getHours()).padStart(2, '0')
	const min = String(now.getMinutes()).padStart(2, '0')
	const base = `REFINED-${mm}${dd}-${hh}${min}`
	if (!existingNames.has(base)) return base
	let suffix = 2
	while (existingNames.has(`${base} (${suffix})`)) suffix++
	return `${base} (${suffix})`
}

const autoRefineInFlight = new Set<string>()

function emitAutoRefine(payload: Record<string, unknown>): void {
	if (!mainWindow.isDestroyed()) mainWindow.webContents.send('ai:autoRefine', payload)
}

/**
 * 录制停止后的自动细化：走与手动细化相同的生成管线（投影 → Pi → 再水化 →
 * parseFlow 校验），成功后经 persistMergedFlow 另存为 REFINED 录制并广播
 * ai:autoRefine。原始录制始终保持原样；任何失败只以事件告知，不影响 Stop。
 */
async function autoRefineRecording(taskCode: string, recording: RecordingMeta): Promise<void> {
	if (autoRefineInFlight.has(recording.id)) return
	autoRefineInFlight.add(recording.id)
	try {
		const status = await piStatus()
		if (!status.available) {
			emitAutoRefine({ state: 'skipped', taskCode, recordingId: recording.id, reason: status.error })
			return
		}
		const result = await generateRefinedFlow({
			flowFiles: [recording.flowFile],
			mode: 'auto',
			runPrompt: (prompt, timeoutMs) => runPiPrompt({ prompt, cwd: flowsRoot, timeoutMs }),
		})
		if (!result.ok) {
			emitAutoRefine({ state: 'failed', taskCode, recordingId: recording.id, error: result.error })
			return
		}
		await taskStore.list()
		const names = new Set((taskStore.get(taskCode)?.recordings ?? []).map((item) => item.name))
		const name = refinedRecordingName(recording.name, names)
		const refined = await persistMergedFlow(taskCode, result.flow, name)
		emitAutoRefine({
			state: 'done',
			taskCode,
			sourceRecordingId: recording.id,
			refinedRecordingId: refined.id,
			name,
		})
	} catch (error) {
		emitAutoRefine({
			state: 'failed',
			taskCode,
			recordingId: recording.id,
			error: error instanceof Error ? error.message : String(error),
		})
	} finally {
		autoRefineInFlight.delete(recording.id)
	}
}

/** 所有 Stop/Test reset 共用同一份收尾，避免并发删除、重复保存或旧会话复活。 */
async function stopRecordingSession(options: { discard?: boolean } = {}): Promise<RecordingStopResult> {
	// 并发 Stop 请求共享同一个收尾 Promise，避免重复保存或删除同一份 Flow；
	// 创建该 Promise 的调用负责最终重置会话状态。
	if (recStopPromise) return recStopPromise
	const stopping = (async (): Promise<RecordingStopResult> => {
		// 先标记 Stop 并打断启动流程：导航或 CDP 附着未必能主动取消，
		// 但包装层会让本次等待立即返回，避免用户被启动阶段卡住。
		recStopRequested = true
		const starting = recStartPromise
		if (starting && !recPromise && !browserView.webContents.isDestroyed()) {
			browserView.webContents.stop()
		}
		recController?.abort()
		if (starting) await starting.catch(() => undefined)
		if (!recPromise) {
			// 尚未进入 recorder 主循环时没有 Flow 可保存，只需清理临时采集目录。
			await discardEmptyRecordingCapture()
			resetRecordingState()
			return { recording: null, reason: 'empty' }
		}

		try {
			// 等待 recorder 冲刷最后一批事件并完成 Flow 写入后，再决定保留或丢弃。
			const result = await recPromise
			if (options.discard) {
				// 浏览器重置等场景要求彻底放弃本次录制，Flow 与对应产物一起清理。
				await discardEmptyRecordingCapture()
				await rm(recOutPath, { force: true }).catch(() => undefined)
				await rm(result.artifactsDir, { recursive: true, force: true }).catch(() => undefined)
				return { recording: null, reason: 'empty' }
			}
			const captureTabs: CaptureTab[] = recordingTabIds.map((tabId, pageIndex) => {
				const view = browserViews.get(tabId)
				const url = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : (recordingTabSnapshots.get(tabId)?.url || '')
				const title = view && !view.webContents.isDestroyed() ? view.webContents.getTitle() : (recordingTabSnapshots.get(tabId)?.title || '')
				const system = resolveSystem(url)
				return { tabId, pageIndex, url, title, active: tabId === activeBrowserTabId, systemId: system.systemId, systemName: system.systemName }
			})
			await writeFlowForgeArchive(result.rawPath, result.flow, captureTabs, result.artifactsDir, recordingHostEvents).catch((error) => {
				console.warn('[flowlink] FlowForge evidence archive could not be written:', (error as Error).message)
			})
			const capture = await stopRecordingCapture()
			let stepScreenshots: string[] = []
			try {
				// 录制步骤截图由 recorder 写入；读取失败不影响 Flow 保存，
				// 因为截图仅作为可选的 UI 预览资料。
				const screenshotDir = join(result.artifactsDir, 'record', 'screenshots')
				stepScreenshots = (await readdir(screenshotDir))
					.filter((name) => /^step-\d+\.png$/i.test(name))
					.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
					.map((name) => join(screenshotDir, name))
			} catch {}
			const recording: RecordingMeta = {
				id: result.flow.id,
				name: generatedRecordingName(),
				flowFile: recOutPath,
				artifactsDir: result.artifactsDir,
				captureDir: recordingCaptureRoot,
				createdAt: result.flow.createdAt,
				steps: result.flow.steps.length,
				posterFile: capture.poster,
				frames: capture.frames,
				stepScreenshots,
			}
			await taskStore.addRecording(recTaskCode, recording)
			// 元数据已持久化后火后即忘地触发自动细化；不阻塞 Stop 响应，
			// 失败只通过 ai:autoRefine 事件告知，细化产物（isMerged）本身不再二次细化。
			if (!recording.isMerged && isAutoRefineEnabled()) {
				void autoRefineRecording(recTaskCode, recording)
			}
			// 先持久化元数据再发送完成事件，确保 UI 收到通知后能立即重新加载。
			if (!mainWindow.isDestroyed())
				mainWindow.webContents.send('recording:done', { recording })
			return { recording }
		} catch (err) {
			if (isEmptyRecordingError(err)) {
				// 空录制是正常取消结果，不生成元数据，也不作为错误通知 UI。
				await discardEmptyRecordingCapture()
				return { recording: null, reason: 'empty' }
			}
			await stopRecordingCapture().catch(() => undefined)
			const message = (err as Error).message
			if (!mainWindow.isDestroyed())
				mainWindow.webContents.send('recording:error', { message })
			return { recording: null, error: message }
		} finally {
			// 所有成功、取消和失败路径都释放会话状态，避免旧 Promise 阻止下次录制。
			resetRecordingState()
		}
	})()
	recStopPromise = stopping
	try {
		return await stopping
	} finally {
		recStopPromise = null
	}
}

async function attachPlaybackPages(): Promise<Page[]> {
	// 按原生标签页 Map 的顺序提供初始页面；回放期间新建的标签页则由
	// EngineBridge 与 openPage 回调另外建立映射。
	const seedPages: Page[] = []
	for (const [tabId, view] of browserViews) {
		try {
			seedPages.push(await engine.pageFor(tabId, view.webContents))
		} catch (err) {
			console.warn(`[flowlink] 回放时附着标签页 ${tabId} 失败：`, (err as Error).message)
		}
	}
	if (!seedPages.length) throw new Error('没有可用的内嵌浏览器标签页用于回放')
	return seedPages
}

function registerIpc(): void {
	// IPC 是渲染进程访问主进程的唯一入口。文件系统、Electron 和引擎操作
	// 均由处理器执行，preload 只公开经过筛选的窄接口。
	/* ---------- 任务 CRUD ---------- */
	ipcMain.handle('processLandscape:load', async () =>
		JSON.parse(
			await readFile(join(app.getAppPath(), 'process_landscape', 'full.json'), 'utf8'),
		),
	)
	ipcMain.handle('tasks:list', () => taskStore.listMetadata())
	ipcMain.handle('tasks:saveProfile', (_e, patch: TaskProfilePatch) =>
		taskStore.upsertProfile(patch),
	)
	ipcMain.handle('tasks:delete', async (_e, code: string) => {
		await taskStore.list()
		const task = taskStore.get(code)
		if (!task) return
		for (const recording of task.recordings) await removeRecordingFiles(recording)
		await taskStore.remove(code)
	})
	ipcMain.handle('tasks:getRecordings', async (_e, code: string) => {
		await taskStore.list()
		return taskStore.get(code)?.recordings ?? []
	})
	ipcMain.handle('tasks:removeRecording', async (_e, code: string, recordingId: string) => {
		await taskStore.list()
		const recording = taskStore.get(code)?.recordings.find((item) => item.id === recordingId)
		if (!recording) return
		await removeRecordingFiles(recording)
		await taskStore.removeRecording(code, recordingId)
	})

	/* ---------- 内嵌浏览器：定位 / 显隐 ---------- */
	ipcMain.handle('browser:setBounds', (_e, rect: { x: number; y: number; width: number; height: number }) => {
		// ResizeObserver 会频繁上报尺寸；合并更新，约每帧只调整一次原生视图，
		// 同时保留由主进程显式控制的可见状态。
		browserSurfaceVisible = true
		browserBounds.x = Math.round(rect.x)
		browserBounds.y = Math.round(rect.y)
		browserBounds.width = Math.max(1, Math.round(rect.width))
		browserBounds.height = Math.max(1, Math.round(rect.height))
		if (!browserView) return
		if (browserBoundsTimer) clearTimeout(browserBoundsTimer)
		browserBoundsTimer = setTimeout(() => {
			if (!browserView || browserView.webContents.isDestroyed()) return
			for (const view of browserViews.values()) {
				view.setBounds(browserBounds)
			}
			syncBrowserVisibility()
		}, 16)
	})
	ipcMain.handle('browser:hide', () => {
		browserSurfaceVisible = false
		syncBrowserVisibility()
	})
	ipcMain.handle('browser:restart', async (_event, initialUrl: string) => {
		// 重启浏览器前串行结束正在进行的录制；不保留半截数据，确保测试
		// 总是从一个干净的原生标签页集合开始。
		if (recStartPromise || recPromise || recStopPromise) {
			await stopRecordingSession({ discard: true })
		}
		const normalized = String(initialUrl || 'https://bosch.com.cn').trim() || 'https://bosch.com.cn'
		let startUrl = normalized
		try {
			// 重启入口也位于进程边界，因此重新验证协议，不信任渲染层输入。
			const parsed = new URL(normalized)
			if (!['http:', 'https:'].includes(parsed.protocol)) startUrl = 'https://bosch.com.cn'
			else startUrl = parsed.href
		} catch {
			startUrl = 'https://bosch.com.cn'
		}

		await resetBrowserTabs(startUrl)
		// 完整重置路径：主标签页的附着缓存也一并放弃，随后后台重新预热。
		engine?.forgetAll()
		void engine?.pageFor(activeBrowserTabId, browserView.webContents).catch(() => {})
		return browserView.webContents.getURL() || startUrl
	})
	ipcMain.handle('browser:createTab', async () => {
		const tabId = `tab-${Date.now()}-${browserViews.size}`
		createBrowserTab(tabId, 'about:blank')
		if ((recPromise || playPromise) && engine) {
			try {
				const view = browserViews.get(tabId)!
				const page = await engine.pageFor(tabId, view.webContents)
				if (!recordingAdditionalPages.includes(page)) recordingAdditionalPages.push(page)
			} catch (err) {
				console.warn(`[flowlink] 新标签页录制附着失败：`, (err as Error).message)
			}
		}
		return { tabId, url: browserViews.get(tabId)?.webContents.getURL() || 'https://bosch.com.cn' }
	})
	ipcMain.handle('browser:switchTab', (_event, tabId: string) => {
		const next = browserViews.get(tabId)
		if (!next) return browserView.webContents.getURL()
		if (browserView !== next) {
			browserView.setVisible(false)
			browserView = next
			activeBrowserTabId = tabId
			if (recPromise) recordingHostEvents.push({ action: 'tabActivated', ts: Date.now(), tabId, url: next.webContents.getURL(), title: next.webContents.getTitle() })
		}
		browserView.setBounds(browserBounds)
		browserSurfaceVisible = true
		syncBrowserVisibility()
		return browserView.webContents.getURL()
	})
	ipcMain.handle('browser:closeTab', (_event, tabId: string) => {
		if (tabId === 'browser' || !browserViews.has(tabId)) return false
		const view = browserViews.get(tabId)!
		if (recPromise) recordingHostEvents.push({ action: 'tabClosed', ts: Date.now(), tabId, url: view.webContents.getURL(), title: view.webContents.getTitle() })
		mainWindow.contentView.removeChildView(view)
		view.webContents.close()
		browserViews.delete(tabId)
		engine?.forget(tabId)
		for (let index = 0; index < recordingAdditionalPages.length; index++) {
			if (recordingAdditionalPages[index].isClosed()) {
				recordingAdditionalPages.splice(index, 1)
				index--
			}
		}
		if (activeBrowserTabId === tabId) {
			activeBrowserTabId = 'browser'
			browserView = browserViews.get('browser')!
			browserView.setBounds(browserBounds)
			syncBrowserVisibility()
		}
		return true
	})

	ipcMain.handle('recording:saveVideo', async (_event, opts: { recordingId: string; taskCode: string; dataUrl: string }) => {
		if (!opts?.dataUrl?.startsWith('data:video/webm')) return null
		const comma = opts.dataUrl.indexOf(',')
		if (comma < 0) return null
		const videoDir = join(artifactsRoot, opts.recordingId, 'record', 'video')
		await mkdir(videoDir, { recursive: true })
		const videoFile = join(videoDir, 'recording.webm')
		await writeFile(videoFile, Buffer.from(opts.dataUrl.slice(comma + 1), 'base64'))
		await taskStore.patchRecording(opts.taskCode, opts.recordingId, { videoFile })
		return videoFile
	})

	ipcMain.handle(
		'recording:persistMerged',
		async (_event, opts: { taskCode: string; flow: Flow; name: string }) =>
			persistMergedFlow(opts.taskCode, opts.flow, opts.name),
	)

	/* ---------- Pi：从已保存录制生成细化的新 Flow（校验后返回，不落盘） ---------- */
	ipcMain.handle(
		'pi:generateFlow',
		async (
			_event,
			opts: {
				taskCode: string
				recordingIds: string[]
				instruction?: string
				conversation?: Array<{ role: string; text: string }>
			},
		) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				!Array.isArray(opts.recordingIds) ||
				!opts.recordingIds.length ||
				opts.recordingIds.some((id) => typeof id !== 'string')
			) {
				throw new Error('Pi generateFlow request is invalid')
			}
			await taskStore.list()
			const task = taskStore.get(opts.taskCode)
			const flowFiles: string[] = []
			for (const recordingId of opts.recordingIds) {
				const recording = task?.recordings.find((item) => item.id === recordingId)
				if (!recording) throw new Error(`Recording not found: ${recordingId}`)
				flowFiles.push(recording.flowFile)
			}
			await mkdir(flowsRoot, { recursive: true })
			const result = await generateRefinedFlow({
				flowFiles,
				instruction: typeof opts.instruction === 'string' ? opts.instruction : undefined,
				conversation: Array.isArray(opts.conversation)
					? opts.conversation.filter(
							(turn): turn is { role: string; text: string } =>
								!!turn && typeof turn === 'object' && typeof (turn as { text?: unknown }).text === 'string',
						)
					: undefined,
				runPrompt: (prompt, timeoutMs) => runPiPrompt({ prompt, cwd: flowsRoot, timeoutMs }),
			})
			if (!result.ok) throw new Error(result.error)
			return {
				flow: result.flow,
				title: result.title,
				summary: result.summary,
				rationale: result.rationale,
				risks: result.risks,
			}
		},
	)

	/* ---------- 内嵌浏览器：导航 ---------- */
	ipcMain.handle('recording:navigate', async (_e, url: string, tabId?: string) => {
		const normalized = normalizeHttpUrl(url)
		const resolvedTabId = tabId || activeBrowserTabId
		const view = browserViews.get(resolvedTabId) ?? browserView
		if (recPromise || recStartPromise) recordingHostEvents.push({ action: 'userNavigateRequested', ts: Date.now(), tabId: resolvedTabId, url: normalized, previousUrl: view.webContents.getURL(), title: view.webContents.getTitle() })
		await view.webContents.loadURL(normalized)
		return view.webContents.getURL()
	})
	ipcMain.handle('recording:goBack', (_e, tabId?: string) => {
		const resolvedTabId = tabId || activeBrowserTabId
		const view = browserViews.get(resolvedTabId) ?? browserView
		if (recPromise || recStartPromise) recordingHostEvents.push({ action: 'historyBackRequested', ts: Date.now(), tabId: resolvedTabId, url: view.webContents.getURL(), title: view.webContents.getTitle() })
		view.webContents.goBack()
		return true
	})
	ipcMain.handle('recording:goForward', (_e, tabId?: string) => {
		const resolvedTabId = tabId || activeBrowserTabId
		const view = browserViews.get(resolvedTabId) ?? browserView
		if (recPromise || recStartPromise) recordingHostEvents.push({ action: 'historyForwardRequested', ts: Date.now(), tabId: resolvedTabId, url: view.webContents.getURL(), title: view.webContents.getTitle() })
		view.webContents.goForward()
		return true
	})
	ipcMain.handle('recording:reload', (_e, tabId?: string) => {
		const resolvedTabId = tabId || activeBrowserTabId
		const view = browserViews.get(resolvedTabId) ?? browserView
		if (recPromise || recStartPromise) recordingHostEvents.push({ action: 'reloadRequested', ts: Date.now(), tabId: resolvedTabId, url: view.webContents.getURL(), title: view.webContents.getTitle() })
		view.webContents.reload()
		return true
	})
	ipcMain.handle('recording:currentUrl', () => browserView.webContents.getURL())

	/* ---------- 录制 ---------- */
	ipcMain.handle(
		'recording:start',
		async (_e, opts: { taskCode: string; startUrl: string; preservePage?: boolean }) => {
		// 拒绝重入，避免共享的录制状态和输出路径被两个会话覆盖。
		if (recStartPromise || recStopPromise || recPromise) throw new Error('已有录制正在进行')
		if (!engine) throw new Error('引擎未就绪（CDP 连接失败）')
		const timing = perf('recording:start')
		timing.mark('enter')

		const controller = new AbortController()
		recController = controller
		recStopRequested = false
		recTaskCode = opts.taskCode
		recOutPath = join(flowsRoot, `${Date.now()}-${opts.taskCode.replace(/[^\w-]/g, '')}.json`)

		const start = (async () => {
			/* 普通录制会重新导航以确保起点明确；分组重录已回放到目标状态，
			   必须保留当前文档及其状态，不能再次刷新。 */
			if (!opts.preservePage) {
				await resetBrowserTabs(opts.startUrl)
				timing.mark('resetBrowserTabs')
			}

			/* 附着 Playwright 到内嵌浏览器的 webContents */
			const page = await withAbort(
				engine.pageFor(activeBrowserTabId, browserView.webContents),
				controller.signal,
			)
			timing.mark('pageFor-primary')
			// 先附着当前页，再附着其他已打开页；标签页顺序必须与主进程
			// browserViews 保持一致，供跨页录制和回放映射复用。
			const additionalPages: Page[] = []
			recordingAdditionalPages = additionalPages
			recordingTabIds = [activeBrowserTabId]
			recordingTabSnapshots.clear()
			recordingHostEvents = []
			for (const [id, view] of browserViews) recordingTabSnapshots.set(id, { url: view.webContents.getURL(), title: view.webContents.getTitle() })
			for (const [tabId, view] of browserViews) {
				if (tabId === activeBrowserTabId) continue
				try {
					additionalPages.push(
						await withAbort(engine.pageFor(tabId, view.webContents), controller.signal),
					)
					recordingTabIds.push(tabId)
				} catch (err) {
					if (controller.signal.aborted) throw err
					console.warn(`[flowlink] 标签页 ${tabId} 未能附着：`, (err as Error).message)
				}
			}
			timing.mark('pages-attached')

			// mkdir 很快完成；不要在 capture timer 尚未建立时让取消流程越过它。
			await startRecordingCapture(`recording-${Date.now()}`)
			timing.mark('capture-installed')
			// 在 recorder 启动前再次检查取消，避免 Stop 与目录创建交错后仍开启录制。
			if (controller.signal.aborted) throw new RecordingStartCancelledError()

			recPromise = recordOnPage({
				page,
				pages: additionalPages,
				tabIds: recordingTabIds,
				keepRaw: true,
				startUrl: opts.startUrl,
				skipNavigate: true,
				outPath: recOutPath,
				artifactsRoot,
				hostEvents: recordingHostEvents,
				stopSignal: controller.signal,
				title: generatedRecordingName(),
				onStep: (step) => {
					if (!mainWindow.isDestroyed())
						mainWindow.webContents.send('recording:step', step)
				},
			})

			/* 录制在后台跑；取消/空录制是正常收尾，不作为错误提示。 */
			recPromise.catch((err: Error) => {
				if (recStopRequested || isEmptyRecordingError(err)) return
				if (!mainWindow.isDestroyed())
					mainWindow.webContents.send('recording:error', { message: err.message })
			})

			return { ok: true }
		})()
		recStartPromise = start
		try {
			const result = await start
			timing.mark('exit')
			return result
		} catch (err) {
			// Stop 引发的错误转换为取消结果；真正的启动错误仍原样抛给 IPC 调用方。
			if (recStopRequested || controller.signal.aborted) {
				return { ok: false, reason: 'cancelled' }
			}
			if (!recPromise) {
				await discardEmptyRecordingCapture()
				resetRecordingState()
			}
			throw err
		} finally {
			recStartPromise = null
		}
	})

	ipcMain.handle('recording:stop', (_e, options?: { discard?: boolean }) =>
		stopRecordingSession(options),
	)

	/* ---------- 节点重录：只回放已有 flow 的前缀，不写 lastRun / 测试状态 ---------- */
	ipcMain.handle(
		'playback:runPrefix',
		async (_e, opts: { taskCode: string; recordingId: string; stepCount: number }) => {
			if (playPromise) throw new Error('已有回放正在进行')
			if (!engine) throw new Error('引擎未就绪（CDP 连接失败）')
			if (!Number.isInteger(opts?.stepCount) || opts.stepCount < 0) {
				throw new Error('stepCount 必须是非负整数')
			}
			const task = taskStore.get(opts.taskCode)
			const recording = task?.recordings.find((r) => r.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			const flow = await loadFlow(recording.flowFile)
			const flattened = flattenSteps(flow.steps)
			// 限制前缀长度到实际步骤数，避免调用方传入过大索引改变切片语义。
			const stepCount = Math.min(opts.stepCount, flattened.length)
			if (stepCount === 0) {
				return {
					ok: true,
					flowId: flow.id,
					runId: '',
					steps: [],
					metrics: { totalMs: 0, passCount: 0, failCount: 0 },
				} satisfies RunResult
			}
			// 只构造并验证临时前缀 Flow；节点重录不得改写原 Flow 或其最近
			// 一次运行记录。
			const prefixFlow = parseFlow(
				{ ...flow, steps: prefixSteps(flow.steps, stepCount) },
				`${recording.flowFile}#prefix-${stepCount}`,
			)
			// 前缀回放需要从 Flow 的起始 URL 重建环境；之后保持页面不刷新，
			// 录制才能直接接续回放抵达的状态。
			await resetBrowserTabs(flow.meta.env.startUrl)
			const seedPages = await attachPlaybackPages()
			const tabIds = [...browserViews.keys()]
			const registrations = new Set<Promise<void>>()
			playAbortController = new AbortController()
			playPromise = playOnPage({
				page: seedPages[0],
				pages: seedPages,
				flow: prefixFlow,
				artifactsRoot,
				timeoutMs: 15_000,
				stepDelayMs: 350,
				highlightSteps: true,
				stopOnFailure: true,
				skipNavigate: false,
				openPage: createNativePlaybackPage(false, (msg) => console.log(`[playback:prefix] ${msg}`)),
				onPage: (page, index) => {
					// Playwright 回调可能先于原生标签页映射登记；用有限轮询等待
					// EngineBridge 完成映射，超时则让整次前缀操作明确失败。
					if (tabIds[index]) return
					const pending = (async () => {
						for (let attempt = 0; attempt < 40; attempt++) {
							const tabId = engine.tabIdForPage(page)
							if (tabId) {
								tabIds[index] = tabId
								return
							}
							await sleep(50)
						}
						throw new Error(`回放标签页 ${index} 缺少原生 tabId 映射`)
					})()
					pending.catch(() => undefined)
					registrations.add(pending)
				},
				onLog: (msg) => console.log(`[playback:prefix:${flow.id}] ${msg}`),
			})
			try {
				const result = await playPromise
				// 等待所有新建页面都拿到原生 ID，再返回给渲染层继续节点重录。
				await Promise.all(registrations)
				return { ...result, tabIds }
			} catch (err) {
				// 即使回放失败，也收齐映射 Promise，避免后台任务跨会话残留。
				await Promise.allSettled(registrations)
				return { ok: false, error: (err as Error).message } as unknown as RunResult
			} finally {
				playPromise = null
			}
		},
	)

	/* ---------- 回放 ---------- */
	ipcMain.handle('playback:run', async (_e, opts: { taskCode: string; recordingId: string; variables?: Record<string, string> }) => {
		if (playPromise) throw new Error('已有回放正在进行')
		if (!engine) throw new Error('引擎未就绪（CDP 连接失败）')
		if (
			opts.variables !== undefined &&
			(!opts.variables ||
				typeof opts.variables !== 'object' ||
				Array.isArray(opts.variables) ||
				Object.entries(opts.variables).some(
					([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string',
				))
		) {
			throw new Error('回放变量无效')
		}

		const task = taskStore.get(opts.taskCode)
		const recording = task?.recordings.find((r) => r.id === opts.recordingId)
		if (!recording) throw new Error('找不到该录制')

		const flow: Flow = await loadFlow(recording.flowFile)

		// 每次完整测试均从录制声明的起始 URL 重新建页，而不是沿用用户当前浏览状态。
		await resetBrowserTabs(flow.meta.env.startUrl)
		const seedPages = await attachPlaybackPages()

		playAbortController = new AbortController()
		playPromise = playOnPage({
			page: seedPages[0],
			pages: seedPages,
			flow,
			artifactsRoot,
			timeoutMs: 15_000,
			stepDelayMs: 350,
			highlightSteps: true,
			stopOnFailure: true,
			variables: opts.variables,
			abortSignal: playAbortController.signal,
			waitForUserOperation: ({ stepId, prompt, signal }) =>
				new Promise<void>((resolve, reject) => {
					const token = makeId('user-operation')
					const cleanup = (): void => {
						pendingUserOperationWaits.delete(token)
						signal?.removeEventListener('abort', onAbort)
					}
					const onAbort = (): void => {
						cleanup()
						reject(new Error('用户操作等待已取消'))
					}
					if (signal?.aborted) {
						onAbort()
						return
					}
					pendingUserOperationWaits.set(token, () => {
						cleanup()
						resolve()
					})
					signal?.addEventListener('abort', onAbort, { once: true })
					if (mainWindow.isDestroyed()) {
						cleanup()
						reject(new Error('应用窗口已关闭，无法继续用户操作等待'))
						return
					}
					mainWindow.webContents.send('playback:userOperation', { token, stepId, prompt })
				}),
			openPage: createNativePlaybackPage(true, (msg) => console.log(`[playback:${flow.id}] ${msg}`)),
			onStep: (r) => {
				if (!mainWindow.isDestroyed())
					mainWindow.webContents.send('playback:step', r)
			},
			onLog: (msg) => {
				console.log(`[playback:${flow.id}] ${msg}`)
			},
		})

		try {
			const result = await playPromise
			// 先推送最终结果，再更新持久化摘要；步骤详情仍由运行产物保存。
			if (!mainWindow.isDestroyed())
				mainWindow.webContents.send('playback:done', result)

			/* 更新 lastRun */
			await taskStore.patchRecording(opts.taskCode, opts.recordingId, {
				lastRun: {
					ok: result.ok,
					at: new Date().toISOString(),
					pass: result.metrics.passCount,
					fail: result.metrics.failCount,
				},
			})

			return result
		} catch (err) {
			// 执行器异常通过事件和 IPC 返回值双向通知，以兼容订阅式与请求式调用方。
			const message = (err as Error).message
			if (!mainWindow.isDestroyed())
				mainWindow.webContents.send('playback:error', { message })
			return { ok: false, error: message } as unknown as RunResult
		} finally {
			playPromise = null
			playAbortController = null
		}
	})

	ipcMain.handle('playback:continueUserOperation', (_event, token: string) => {
		const resume = pendingUserOperationWaits.get(token)
		if (!resume) return false
		resume()
		return true
	})

	ipcMain.handle('playback:stop', async () => {
		if (!playAbortController) return false
		playAbortController.abort()
		if (playPromise) {
			const current = playPromise
			await current.catch(() => undefined)
		}
		return true
	})


	/* ---------- Pi Coding Agent: AI bedrock ---------- */
	ipcMain.handle('pi:status', async () => piStatus())
	ipcMain.handle('pi:prewarm', () => prewarmPi())
	ipcMain.handle('pi:prompt', async (_event, opts: { prompt: string; timeoutMs?: number }) => {
		if (!opts || typeof opts.prompt !== 'string') throw new Error('Pi request is invalid')
		// Keep the agent's workspace inside FlowLink's own workflow/artifact directory.
		// This workflow assistant has no Pi tools enabled; FlowLink validates and persists any generated material itself.
		await mkdir(flowsRoot, { recursive: true })
		const result = await runPiPrompt({ prompt: opts.prompt, cwd: flowsRoot, timeoutMs: opts.timeoutMs })
		if (!result.ok) throw new Error(result.error || 'Pi agent request failed')
		return { text: result.text }
	})

	/* ---------- Flow 读取（分析页用） ---------- */
	ipcMain.handle('flow:load', async (_e, flowFile: string) => {
		const flow: Flow = await loadFlow(flowFile)
		return flow
	})
	ipcMain.handle(
		'flow:updateVariables',
		async (_event, opts: { taskCode: string; recordingId: string; variables: unknown[] }) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				!Array.isArray(opts.variables)
			) {
				throw new Error('变量更新请求无效')
			}
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			const flow = await loadFlow(recording.flowFile)
			const updated = parseFlow({
				...flow,
				version: flow.version + 1,
				variables: opts.variables,
			}, recording.flowFile)
			await saveFlow(updated, recording.flowFile)
			return updated.variables
		},
	)
	ipcMain.handle(
		'flow:updateSteps',
		async (_event, opts: { taskCode: string; recordingId: string; steps: unknown[] }) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				!Array.isArray(opts.steps)
			) {
				throw new Error('Flow steps 更新请求无效')
			}
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			const flow = await loadFlow(recording.flowFile)
			const updated = parseFlow({
				...flow,
				version: flow.version + 1,
				steps: opts.steps,
			}, recording.flowFile)
			await saveFlow(updated, recording.flowFile, { backup: true })
			return updated
		},
	)
}
