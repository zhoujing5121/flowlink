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
import { app, BrowserWindow, ipcMain, session, WebContentsView } from 'electron'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { TaskStore, type RecordingMeta, type TaskProfilePatch } from './store.js'
import { EngineBridge } from './engine-bridge.js'
import { disposePiWorker, getPromptTemplates, getPiProxyOptions, getTakeoverModelConfig, piStatus, prewarmPi, runPiPrompt } from './pi-agent.js'
import { aiTakeoverInProgress, abortAiTakeover, startAiTakeover, type GateEvaluation, type TakeoverEvidence, type TakeoverEvidenceNode, type TakeoverEvidencePage } from './ai-takeover.js'
import { perf, perfSinceAppStart } from './perf.js'
import { elementKey, generateRefinedFlow, projectFlows, type ReanchorEntry } from './ai-refine.js'
import { EmptyRecordingError, recordOnPage, writeFlowForgeArchive, resolveSystem, type CaptureTab, type HostCaptureEvent, type RecordResult } from '../engine/recorder/src/index.js'
import { evaluateAssertion, flattenSteps, playOnPage, prefixSteps, type RunResult, type VerifyDeps } from '../engine/executor/src/index.js'
import { resolve as resolveElement } from '../engine/resolver/src/index.js'
import { loadFlow, parseFlow, saveFlow, makeId, type Assertion, type Candidate, type ElementRef } from '../engine/schema/src/index.js'
import { attachRrwebPage, recordRrwebActivation, startRrwebRecording, stopRrwebRecording, type RrwebPageSeed } from './rrweb-capture.js'
import type { Flow } from '../engine/schema/src/index.js'
import type { Page } from 'playwright-core'

const __dirname = dirname(fileURLToPath(import.meta.url))

/* Electron CDP：Playwright connectOverCDP 的前提 */
app.commandLine.appendSwitch('remote-debugging-port', '0')

/* browser-use SDK 默认开启匿名遥测；企业环境一律关闭（SDK 侧另有 telemetry:false 双保险）。 */
process.env.DO_NOT_TRACK ||= '1'

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
/* rrweb 录制根目录（recording-<ts>，沿用 captureDir 清理守卫）与 poster 单次截图 */
let recordingCaptureRoot = ''
let recordingPosterTimer: ReturnType<typeof setTimeout> | null = null
let recordingPosterFile = ''
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
	recordingPosterFile = ''
	if (recordingPosterTimer) {
		clearTimeout(recordingPosterTimer)
		recordingPosterTimer = null
	}
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
	// makeId 生成 recording_<ts>_<rand>（下划线），普通录制为 <ts>-<taskCode>；
	// 两种都由本应用生成，删除守卫都要放行。
	if (!/^(?:\d+-[\w-]+|recording[-_][\w-]+)\.json$/i.test(basename(flowFile))) {
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
	await stopRrwebRecording().catch(() => undefined)
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
				if (recPromise || recStartPromise) {
					void attachRrwebPage({ page, tabId, label: recordingTabLabel(tabId) }).catch((err) => {
						console.warn(`[flowlink] rrweb 挂接新标签页失败：`, (err as Error).message)
					})
				}
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

/** 模式切换前把内嵌浏览器还原到单一 start-URL 标签页；cookie/storage/cache 保留。
 * 每次打开（录制 / Test / 前缀回放 / 手动重启）都视为全新浏览器会话：关闭多余
 * 标签页并无条件重新加载起始 URL——同地址的旧页面是上一轮运行的脏状态（SPA
 * 状态已推进、DOM 已变化），不能作为起点。preservePage 的分组重录路径不经过
 * 本函数（前缀回放抵达的状态必须保留）。
 *
 * opts.navigate=false：不触发 loadURL——首个可执行步骤是 navigate 的流程把
 * 唯一导航交给执行器首步 goto，根除「Electron loadURL 与 CDP goto 双导航
 * 在途竞争 → 间歇 net::ERR_ABORTED」的竞态。其余调用保持默认导航，但改为
 * 有界等待加载完成（awaitLoadMs，默认 10s；超时不失败，执行器 startUrl
 * goto 自带 2 次重试兜底），不再 fire-and-forget 地与执行器竞争。 */
async function resetBrowserTabs(
	initialUrl: string,
	opts?: { navigate?: boolean; awaitLoadMs?: number },
): Promise<void> {
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
	if (opts?.navigate === false) {
		// 唯一导航由执行器首步 goto 完成（首步 navigate 的流程）；页面保持
		// 现状（about:blank 或上一会话地址），视图反正对用户隐藏。
		return
	}
	// 导航并等待完成（有界）：loadURL 的 promise 在 did-finish-load 时 resolve；
	// 失败吞掉（网络抖动等），超时不视为错误——后续 startUrl goto 有重试兜底。
	const load = browserView.webContents.loadURL(startUrl).catch(() => undefined)
	const budgetMs = Math.max(0, opts?.awaitLoadMs ?? 10_000)
	await Promise.race([load, new Promise((resolve) => setTimeout(resolve, budgetMs))])
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

/** rrweb manifest 与播放器标签按钮使用的标签页显示名（编号与录制时标签顺序一致）。 */
function recordingTabLabel(tabId: string): string {
	const index = recordingTabIds.indexOf(tabId)
	const view = browserViews.get(tabId)
	const url =
		view && !view.webContents.isDestroyed()
			? view.webContents.getURL()
			: (recordingTabSnapshots.get(tabId)?.url || '')
	const title =
		view && !view.webContents.isDestroyed()
			? view.webContents.getTitle()
			: (recordingTabSnapshots.get(tabId)?.title || '')
	const text = (title && title !== url ? title : url) || 'Tab'
	return `Tab ${index >= 0 ? index + 1 : 1} · ${text}`.slice(0, 120)
}

/**
 * 录制开始后约 1.2s 单次截取 poster（Record 列表缩略图兼容旧格式）。
 * 单次 capturePage 不构成闪烁/点击丢失源（旧管线的问题是 800ms 周期轮询）。
 */
function scheduleRecordingPoster(): void {
	if (recordingPosterTimer) clearTimeout(recordingPosterTimer)
	const root = recordingCaptureRoot
	const tabId = activeBrowserTabId
	recordingPosterTimer = setTimeout(() => {
		recordingPosterTimer = null
		const view = browserViews.get(tabId)
		if (!root || root !== recordingCaptureRoot || !view || view.webContents.isDestroyed()) return
		void view.webContents
			.capturePage()
			.then(async (image) => {
				const png = image.toPNG()
				if (!png.length) return
				const posterDir = join(root, 'record')
				await mkdir(posterDir, { recursive: true })
				recordingPosterFile = join(posterDir, 'poster.png')
				await writeFile(recordingPosterFile, png)
			})
			.catch(() => undefined)
	}, 1200)
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
				if (recPromise || recStartPromise) {
					void attachRrwebPage({ page, tabId, label: recordingTabLabel(tabId) }).catch((err) => {
						console.warn(`[flowlink] rrweb 挂接新标签页失败：`, (err as Error).message)
					})
				}
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

/** 把（已通过 schema 校验的）细化 Flow 保存为一条全新的 isRefined 录制；永不覆盖已有录制。 */
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
		isRefined: true,
	}
	await taskStore.addRecording(taskCode, recording)
	return recording
}

/* ================================================================ */
/* REFINED 单线演进：pending 暂存（Confirm/Discard 决议）与生效前快照 */
/* ================================================================ */

/** pending 文件（artifacts/<flowId>/pending.json）的单槽数据形状。 */
interface FlowPending {
	version: 1
	createdAt: string
	source: 'refine' | 'takeover-repair'
	/** 完整且已通过 parseFlow 校验的 Flow。 */
	flow: Flow
	summary: string
	risks: string[]
	/** 生成 pending 时正式 Flow 的 version；Confirm 时必须与当前 version 一致。 */
	baseVersion: number
}

const PENDING_SOURCES = ['refine', 'takeover-repair'] as const

function pendingPathOf(recording: RecordingMeta): string {
	return join(recording.artifactsDir, 'pending.json')
}

/** 原子写小 JSON（tmp + rename；临时文件与目标同目录保证 rename 原子性）。 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.tmp`
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
	await rename(tmp, file)
}

/** 读 pending：文件不存在/损坏时返回 null（文件是唯一事实源，标记仅作提示）。 */
async function readPending(recording: RecordingMeta): Promise<FlowPending | null> {
	try {
		const raw = JSON.parse(await readFile(pendingPathOf(recording), 'utf8')) as FlowPending
		if (
			!raw ||
			typeof raw !== 'object' ||
			raw.version !== 1 ||
			!raw.flow ||
			typeof raw.flow !== 'object' ||
			typeof raw.baseVersion !== 'number'
		) {
			return null
		}
		return raw
	} catch {
		return null
	}
}

interface FlowHistoryEntry {
	version: number
	at: string
	source: 'human' | 'refine-apply' | 'repair-apply'
	summary: string
}

/**
 * 生效前历史快照：把即将被覆盖的完整旧版 Flow 存入
 * artifacts/<flowId>/history/v<N>-<ts>.json，并维护 index.json 条目表。
 * 只存不用（无查看 UI）；任何写失败只记日志，绝不阻塞流程生效主流程。
 */
async function writeFlowHistorySnapshot(
	recording: RecordingMeta,
	flowBefore: Flow,
	source: FlowHistoryEntry['source'],
	summary: string,
): Promise<void> {
	try {
		const dir = join(recording.artifactsDir, 'history')
		const now = new Date()
		const pad = (value: number) => String(value).padStart(2, '0')
		const ts =
			`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
			`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		await writeJsonAtomic(join(dir, `v${flowBefore.version}-${ts}.json`), flowBefore)
		const indexFile = join(dir, 'index.json')
		let entries: FlowHistoryEntry[] = []
		try {
			const parsed = JSON.parse(await readFile(indexFile, 'utf8')) as { entries?: unknown }
			if (Array.isArray(parsed?.entries)) {
				entries = parsed.entries.filter(
					(entry): entry is FlowHistoryEntry =>
						!!entry &&
						typeof entry === 'object' &&
						typeof (entry as { version?: unknown }).version === 'number' &&
						typeof (entry as { at?: unknown }).at === 'string',
				)
			}
		} catch {
			/* 首次写入或 index 损坏：从空表重建 */
		}
		entries.push({ version: flowBefore.version, at: now.toISOString(), source, summary })
		await writeJsonAtomic(indexFile, { version: 1, entries })
	} catch (error) {
		console.warn(`[flowlink] 历史快照写入失败（忽略，不阻塞流程生效）: ${(error as Error).message}`)
	}
}

/**
 * 流程生效内核（Confirm 决议与接管修复直落盘共用）：生效前历史快照 →
 * version+1 + parseFlow 完整校验 → 覆盖正式 Flow（.bak 备份）。返回新版 Flow。
 */
async function persistFlowUpdate(
	recording: RecordingMeta,
	flow: Flow,
	source: FlowHistoryEntry['source'],
	summary: string,
): Promise<Flow> {
	const current = await loadFlow(recording.flowFile)
	await writeFlowHistorySnapshot(recording, current, source, summary)
	const updated = parseFlow({ ...flow, version: current.version + 1 }, recording.flowFile)
	await saveFlow(updated, recording.flowFile, { backup: true })
	return updated
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
			// poster 单次截图到此为止；rrweb 收尾（页面停录 + 事件流 flush + 终版 manifest）。
			if (recordingPosterTimer) {
				clearTimeout(recordingPosterTimer)
				recordingPosterTimer = null
			}
			const rrweb = await stopRrwebRecording().catch(() => ({
				dir: '',
				tabCount: 0,
				eventCount: 0,
			}))
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
				captureDir: recordingCaptureRoot || undefined,
				rrwebDir: rrweb.dir || undefined,
				createdAt: result.flow.createdAt,
				steps: result.flow.steps.length,
				posterFile: recordingPosterFile,
				// 旧字段保留兼容旧数据；新录制不再产出 PNG 帧序列
				frames: [],
				stepScreenshots,
			}
			await taskStore.addRecording(recTaskCode, recording)
			// REFINED 只来自用户在 AI 面板主动 Refine（第三轮决策：停止录屏
			// 不再自动生成细化孪生；autoRefine 设置与 ai:autoRefine 事件已移除）。
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
			await stopRrwebRecording().catch(() => undefined)
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

/* ---------------- AI 接管辅助：页面枚举 / 网关求值 / 证据抓取 ---------------- */

/** 接管现场可用的 Playwright 页面（活动标签页优先，去重、容忍个别附着失败）。 */
async function attachedTakeoverPages(): Promise<Page[]> {
	const pages: Page[] = []
	const seen = new Set<Page>()
	const tryAdd = async (tabId: string): Promise<void> => {
		const view = browserViews.get(tabId)
		if (!view || view.webContents.isDestroyed()) return
		try {
			const page = await engine.pageFor(tabId, view.webContents)
			if (!seen.has(page)) {
				seen.add(page)
				pages.push(page)
			}
		} catch {
			/* 单个标签页附着失败不影响其余页面 */
		}
	}
	await tryAdd(activeBrowserTabId)
	for (const tabId of browserViews.keys()) {
		if (tabId !== activeBrowserTabId) await tryAdd(tabId)
	}
	return pages
}

/**
 * 网关 condition 本地求值（执行器同款 evaluateAssertion + resolver 解析）。
 * 逐页尝试：任一页面命中即视为 matches（登录网关语义 = 目标页元素在任一打开的
 * 标签页上可见）；所有页面都无法给出确定答案时返回 null（接管保守线性继续）。
 */
async function evaluateTakeoverGate(
	assertion: Assertion,
	target: ElementRef | undefined,
): Promise<GateEvaluation | null> {
	try {
		const pages = await attachedTakeoverPages()
		if (!pages.length) return null
		let definitive = false
		for (const page of pages) {
			const verifyDeps: VerifyDeps = {
				page,
				timeoutMs: 5_000,
				log: () => {},
				resolveTarget: (ref, opts) =>
					resolveElement(ref, {
						page,
						log: () => {},
						options: {
							requireVisible: opts?.requireVisible ?? false,
							allowAi: false,
							elementWaitMs: opts?.elementWaitMs ?? 1_500,
						},
					}),
				pollResolveMs: 1_000,
			}
			try {
				const outcome = await evaluateAssertion(verifyDeps, assertion, target)
				definitive = true
				if (outcome.matches) return outcome
			} catch {
				/* 该页面导航中/不可评估：换下一页 */
			}
		}
		return definitive
			? { matches: false, note: `${assertion.kind} did not match on any open page` }
			: null
	} catch {
		return null
	}
}

/** 证据采集用的页面脚本：交互元素摘要（不读任何输入值，secret 不可能进入证据）。 */
const TAKEOVER_EVIDENCE_SCRIPT = `(() => {
	const nodes = []
	const selector = 'a[href], button, input, select, textarea, [role], [data-testid], [data-test-id], [aria-label]'
	for (const el of document.querySelectorAll(selector)) {
		if (nodes.length >= 40) break
		const tag = el.tagName.toLowerCase()
		let role = el.getAttribute('role')
		if (!role) {
			if (tag === 'a') role = 'link'
			else if (tag === 'button') role = 'button'
			else if (tag === 'select') role = 'combobox'
			else if (tag === 'textarea') role = 'textbox'
			else if (tag === 'input') {
				const type = (el.getAttribute('type') || 'text').toLowerCase()
				role = type === 'button' || type === 'submit' ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox'
			}
		}
		const name = String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.labels && el.labels[0] ? el.labels[0].textContent : '') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
		const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || ''
		const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
		const id = el.id || ''
		if (!role && !name && !testid && !text) continue
		nodes.push({ tag, ...(role ? { role } : {}), ...(name ? { name } : {}), ...(testid ? { testid } : {}), ...(text && text !== name ? { text } : {}), ...(id ? { id } : {}) })
	}
	return nodes
})()`

/**
 * 接管证据抓取：当前打开页面的交互元素摘要（活动页优先，页数与节点数有上限）。
 * 只在 agent 运行间隙调用（不与 agent 的 CDP 会话并发操作同一页面）。
 */
async function captureTakeoverEvidence(): Promise<TakeoverEvidence | null> {
	try {
		const pages = await attachedTakeoverPages()
		const out: TakeoverEvidencePage[] = []
		for (const page of pages.slice(0, 5)) {
			try {
				const url = page.url()
				if (!/^https?:/i.test(url)) continue
				const nodes = (await page.evaluate(TAKEOVER_EVIDENCE_SCRIPT)) as TakeoverEvidenceNode[]
				if (!Array.isArray(nodes) || !nodes.length) continue
				let title = ''
				try {
					title = await page.title()
				} catch {
					/* 标题拿不到不影响证据 */
				}
				out.push({ url, title, nodes })
			} catch {
				/* 页面导航中：跳过 */
			}
		}
		return out.length ? { pages: out } : null
	} catch {
		return null
	}
}

/** 宿主侧「等待用户操作/人工步骤确认」：token + playback:userOperation 事件。 */
function hostWaitForUserOperation(opts: {
	stepId: string
	prompt: string
	signal?: AbortSignal
}): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const token = makeId('user-operation')
		const cleanup = (): void => {
			pendingUserOperationWaits.delete(token)
			opts.signal?.removeEventListener('abort', onAbort)
		}
		const onAbort = (): void => {
			cleanup()
			reject(new Error('用户操作等待已取消'))
		}
		if (opts.signal?.aborted) {
			onAbort()
			return
		}
		pendingUserOperationWaits.set(token, () => {
			cleanup()
			resolve()
		})
		opts.signal?.addEventListener('abort', onAbort, { once: true })
		if (mainWindow.isDestroyed()) {
			cleanup()
			reject(new Error('应用窗口已关闭，无法继续用户操作等待'))
			return
		}
		mainWindow.webContents.send('playback:userOperation', { token, stepId: opts.stepId, prompt: opts.prompt })
	})
}

/* ---------------- 修复链路的证据匹配与候选重锚定（Phase 4） ---------------- */

function normalizeEvidenceName(value: string | undefined): string {
	return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function describeEvidenceNode(node: TakeoverEvidenceNode): string {
	const bits = [node.tag]
	if (node.role) bits.push(`role="${node.role}"`)
	if (node.name) bits.push(`name="${node.name}"`)
	if (node.testid) bits.push(`testid="${node.testid}"`)
	if (node.id) bits.push(`id="${node.id}"`)
	if (node.text && node.text !== node.name) bits.push(`text="${node.text.slice(0, 40)}"`)
	return `<${bits.join(' ')}>`
}

/** 证据节点 → 候选（只做语义形态：testid / role+name / text；不让模型发明选择器）。 */
function reanchorCandidates(node: TakeoverEvidenceNode): Candidate[] {
	const out: Candidate[] = []
	if (node.testid) out.push({ kind: 'testid', value: node.testid, score: 0, source: 'ai' })
	if (node.role && node.name) {
		out.push({ kind: 'role', value: { role: node.role, name: node.name }, score: 0, source: 'ai' })
	} else if (node.text) {
		out.push({ kind: 'text', value: node.text.slice(0, 60), score: 0, source: 'ai' })
	}
	return out
}

/**
 * 元素证据匹配（主进程做的简单归一化比对）：
 * 想要的 role/name/tag 与证据节点比对打分，top1 超阈值才算命中；
 * 证据节点上与录制 testid 候选完全一致的直接强命中。
 */
function matchEvidenceNode(
	ref: ElementRef,
	pages: TakeoverEvidencePage[],
): { node: TakeoverEvidenceNode; url: string } | null {
	const wantRole = String(ref.fingerprint?.role ?? '').toLowerCase()
	const wantName = normalizeEvidenceName(
		ref.fingerprint?.accessibleName || ref.observed?.text || ref.description || '',
	)
	const wantTag = String(ref.observed?.tag ?? ref.fingerprint?.tag ?? '').toLowerCase()
	const recordedTestids = (ref.candidates ?? [])
		.filter((candidate) => candidate.kind === 'testid' && typeof candidate.value === 'string')
		.map((candidate) => candidate.value as string)
	let best: { node: TakeoverEvidenceNode; url: string; score: number } | null = null
	for (const page of pages) {
		for (const node of page.nodes) {
			let score = 0
			const nodeName = normalizeEvidenceName(node.name || node.text || '')
			if (wantName && nodeName) {
				if (nodeName === wantName) score += 2
				else if (nodeName.includes(wantName) || wantName.includes(nodeName)) score += 1
			}
			if (wantRole && node.role && node.role.toLowerCase() === wantRole) score += 1
			if (wantTag && node.tag === wantTag) score += 0.5
			if (node.testid && recordedTestids.includes(node.testid)) score += 3
			if (!best || score > best.score) best = { node, url: page.url, score }
		}
	}
	// 阈值 2.5：testid 一致（3）、name 精确 + role（3）、name 精确 + tag（2.5）、
	// name 包含 + role（2）不行——宁可漏报交给模型，也不误锚定。
	return best && best.score >= 2.5 ? { node: best.node, url: best.url } : null
}

interface RepairEvidence {
	/** 注入修复 instruction 的证据行。 */
	lines: string[]
	/** 元素身份键 → 前插候选（source:'ai'）。 */
	reanchor: ReanchorEntry[]
}

/**
 * 读取接管 artifact 的证据，与源流程元素库匹配：
 * 命中 → 证据行（“=> library eN”）+ 重锚定候选；未命中 → 作为新元素证据行。
 */
async function buildRepairEvidence(flowFile: string, artifactDir: string): Promise<RepairEvidence | null> {
	const dir = resolve(artifactDir)
	const rel = relative(resolve(artifactsRoot), dir)
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error('接管证据目录不在 artifacts 根内，拒绝读取')
	}
	const raw = JSON.parse(await readFile(join(dir, 'ai-takeover.json'), 'utf8')) as {
		steps?: Array<{
			ok?: boolean
			stepIndex?: number
			skipped?: boolean
			freeRun?: boolean
			evidencePages?: TakeoverEvidencePage[]
		}>
	}
	const flow = await loadFlow(flowFile)
	const flat = flattenSteps(flow.steps)
	const projection = projectFlows([flow])
	const libByKey = new Map(projection.library.map((entry) => [elementKey(entry.ref), entry]))
	const lines: string[] = []
	const reanchorByKey = new Map<string, Candidate[]>()
	// free-run 标记记录自身没有证据页；用汇总记录（stepIndex=-1）的最终现场兜底。
	const freeRunEvidence = (raw.steps ?? []).find(
		(record) =>
			record?.freeRun === true &&
			record.stepIndex === -1 &&
			Array.isArray(record.evidencePages) &&
			record.evidencePages.length > 0,
	)?.evidencePages
	for (const record of raw.steps ?? []) {
		if (!record?.ok || record.skipped) continue
		if (!Number.isInteger(record.stepIndex) || (record.stepIndex as number) < 0) continue
		const evidencePages =
			Array.isArray(record.evidencePages) && record.evidencePages.length
				? record.evidencePages
				: record.freeRun === true && Array.isArray(freeRunEvidence)
					? freeRunEvidence
					: null
		if (!evidencePages) continue
		const flatStep = flat[record.stepIndex as number]
		const stepRefs: ElementRef[] = []
		const step = flatStep?.step as
			| { target?: ElementRef; from?: ElementRef; to?: { target?: ElementRef }; expect?: { target?: ElementRef } }
			| undefined
		if (step?.target) stepRefs.push(step.target)
		if (step?.from) stepRefs.push(step.from)
		if (step?.to?.target) stepRefs.push(step.to.target)
		if (step?.expect?.target) stepRefs.push(step.expect.target)
		const stepLabel = flatStep?.step.label ? ` (${flatStep.step.label})` : ''
		const stepName = `step ${flatStep?.stepId ?? record.stepIndex}${stepLabel}`
		const hits = stepRefs
			.map((ref) => ({ ref, hit: matchEvidenceNode(ref, evidencePages) }))
			.filter((entry): entry is { ref: ElementRef; hit: { node: TakeoverEvidenceNode; url: string } } => !!entry.hit)
		if (!hits.length) {
			const page = evidencePages[0]!
			const sample = page.nodes
				.slice(0, 3)
				.map((node) => describeEvidenceNode(node))
				.join(' ')
			lines.push(`- ${stepName}: no library element matched; page ${page.url} showed (sample) ${sample}`)
			continue
		}
		for (const { ref, hit } of hits) {
			const libEntry = libByKey.get(elementKey(ref))
			lines.push(
				`- ${stepName}: page ${hit.url} — ${describeEvidenceNode(hit.node)}${libEntry ? ` => library ${libEntry.id}` : ''}`,
			)
			if (libEntry) {
				const candidates = reanchorCandidates(hit.node)
				if (candidates.length) {
					const key = elementKey(ref)
					const existing = reanchorByKey.get(key) ?? []
					for (const candidate of candidates) {
						if (!existing.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) {
							existing.push(candidate)
						}
					}
					reanchorByKey.set(key, existing)
				}
			}
		}
	}
	return {
		lines: lines.slice(0, 60),
		reanchor: [...reanchorByKey.entries()].map(([key, candidates]) => ({ key, candidates })),
	}
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
		// 回放进行中不允许重启：重启会销毁回放附着的页面，把运行中的 Test 杀掉。
		// 空闲重置（打开工作区时的默认 URL 恢复）与 Test 启动存在异步竞态，
		// 必须在进程边界拒绝而不是依赖渲染层时序。
		if (playPromise) throw new Error('回放正在进行，无法重启浏览器')
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
				if (recPromise || recStartPromise) {
					await attachRrwebPage({ page, tabId, label: recordingTabLabel(tabId) })
				}
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
			if (recPromise) {
				recordingHostEvents.push({ action: 'tabActivated', ts: Date.now(), tabId, url: next.webContents.getURL(), title: next.webContents.getTitle() })
				recordRrwebActivation(tabId)
			}
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

	/** 读取一段 rrweb 录制（manifest + 各标签页事件流）供 Record 标签页回放。
	 * 目录必须位于 artifacts 管辖的 recording-<id> / record / rrweb 内，防路径注入。 */
	ipcMain.handle('recording:loadRrweb', async (_event, dir: string) => {
		const root = resolve(artifactsRoot)
		const target = resolve(String(dir || ''))
		const rel = relative(root, target)
		const parts = typeof rel === 'string' && rel && !rel.startsWith('..') ? rel.split(sep) : []
		if (parts.length !== 3 || !parts[0].startsWith('recording-') || parts[1] !== 'record' || parts[2] !== 'rrweb') {
			throw new Error('Refusing to load an rrweb capture outside its managed directory')
		}
		const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as {
			startedAt?: number
			tabs?: Array<{ tabId?: string; label?: string; file?: string }>
			activations?: unknown
		}
		const loadedTabs: Array<{ tabId: string; label: string; events: unknown[] }> = []
		for (const tab of manifest.tabs ?? []) {
			if (typeof tab.file !== 'string' || !/^[\w.-]+\.jsonl$/i.test(tab.file)) continue
			let raw = ''
			try {
				raw = await readFile(join(target, tab.file), 'utf8')
			} catch {
				continue
			}
			const events: unknown[] = []
			for (const line of raw.split('\n')) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					const parsed = JSON.parse(trimmed) as { event?: unknown }
					if (parsed && typeof parsed === 'object' && 'event' in parsed) events.push(parsed.event)
				} catch {
					/* 尾部残行（崩溃截断）跳过 */
				}
			}
			loadedTabs.push({
				tabId: String(tab.tabId ?? ''),
				label: String(tab.label ?? tab.tabId ?? 'Tab'),
				events,
			})
		}
		const activations = Array.isArray(manifest.activations)
			? manifest.activations.filter(
					(item): item is { ts: number; tabId: string } =>
						!!item &&
						typeof item === 'object' &&
						typeof (item as { ts?: unknown }).ts === 'number' &&
						typeof (item as { tabId?: unknown }).tabId === 'string',
				)
			: []
		return {
			startedAt: typeof manifest.startedAt === 'number' ? manifest.startedAt : 0,
			activations,
			tabs: loadedTabs,
		}
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
			const sources: Array<{
				recordingId: string
				flowId: string
				title: string
				flowFile: string
			}> = []
			for (const recordingId of opts.recordingIds) {
				const recording = task?.recordings.find((item) => item.id === recordingId)
				if (!recording) throw new Error(`Recording not found: ${recordingId}`)
				flowFiles.push(recording.flowFile)
				// 溯源元数据：此处同时知道 recordingId、flowFile 与已加载 flow 的
				// id/title；生成结果的 meta.sourceFlows 记直接来源（不递归展开）。
				const sourceFlow = await loadFlow(recording.flowFile)
				sources.push({
					recordingId,
					flowId: sourceFlow.id,
					title: sourceFlow.title,
					flowFile: recording.flowFile,
				})
			}
			await mkdir(flowsRoot, { recursive: true })
			const result = await generateRefinedFlow({
				flowFiles,
				sources,
				instruction: typeof opts.instruction === 'string' ? opts.instruction : undefined,
				conversation: Array.isArray(opts.conversation)
					? opts.conversation.filter(
							(turn): turn is { role: string; text: string } =>
								!!turn && typeof turn === 'object' && typeof (turn as { text?: unknown }).text === 'string',
						)
					: undefined,
				templates: getPromptTemplates().generation,
				runPrompt: (prompt, timeoutMs) => runPiPrompt({ prompt, cwd: flowsRoot, timeoutMs }),
			})
			if (!result.ok) {
				// 完整错误文本随消息返回；detail（阶段+原因）供渲染层折叠展示。
				const error = new Error(result.error) as Error & { detail?: { stage: string; reason: string } }
				error.detail = result.detail
				throw error
			}
			return {
				flow: result.flow,
				title: result.title,
				summary: result.summary,
				rationale: result.rationale,
				risks: result.risks,
			}
		},
	)

	/* ---------- Pi：AI 接管后的一键流程修复（带失败与接管证据重跑细化，返回步骤提案不落盘） ---------- */
	ipcMain.handle(
		'pi:repairFlow',
		async (
			_event,
			opts: {
				taskCode: string
				recordingId: string
				takeover?: {
					ok?: boolean
					summary?: string
					aiCompleted?: number
					failedSteps?: Array<{ stepId: string; label?: string; error?: string }>
					aiSteps?: string[]
					/** 本次接管的 artifact 目录（ai-takeover.json 所在；主进程做路径白名单校验）。 */
					artifactDir?: string
				}
			},
		) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				(opts.takeover !== undefined &&
					(typeof opts.takeover !== 'object' || Array.isArray(opts.takeover)))
			) {
				throw new Error('Pi repairFlow request is invalid')
			}
			const takeover = opts.takeover ?? {}
			await taskStore.list()
			const task = taskStore.get(opts.taskCode)
			const recording = task?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error(`Recording not found: ${opts.recordingId}`)
			const failures = (takeover.failedSteps ?? [])
				.map(
					(step) =>
						`- step ${step.stepId}${step.label ? ` (${step.label})` : ''}: ${
							step.error || 'failed'
						}`,
				)
				.join('\n')
			const aiDone = (takeover.aiSteps ?? []).map((label) => `- ${label}`).join('\n')
			// 结构化元素证据 + 受控重锚定（Phase 4）：证据目录由渲染端从接管 artifact 传入，
			// 主进程校验路径在 artifacts 根内后读取 ai-takeover.json 并与源流程元素匹配。
			let evidenceSection = ''
			let reanchor: ReanchorEntry[] | undefined
			if (typeof takeover.artifactDir === 'string' && takeover.artifactDir.trim()) {
				const evidence = await buildRepairEvidence(recording.flowFile, takeover.artifactDir).catch(
					(error) => {
						console.warn(`[pi:repairFlow] 接管证据读取失败（忽略，继续无证据修复）: ${(error as Error).message}`)
						return null
					},
				)
				if (evidence) {
					if (evidence.reanchor.length) reanchor = evidence.reanchor
					if (evidence.lines.length) {
						evidenceSection = [
							'Structured element evidence from the AI takeover (what the live pages actually showed when the agent succeeded; "=> library eN" marks the matching library element, which is also re-anchored automatically by prepending a new high-priority "ai" candidate - keep observed evidence unchanged):',
							...evidence.lines,
						].join('\n')
					}
				}
			}
			const instruction = [
				'Repair this workflow so the next replay succeeds without AI takeover.',
				'The previous replay failed at these steps:',
				failures || '- (failure details unavailable)',
				takeover.summary
					? `An AI agent then completed the remaining steps in a live browser. Takeover summary: ${takeover.summary}`
					: '',
				aiDone
					? `Steps the AI agent completed (evidence of what actually works on the page):\n${aiDone}`
					: '',
				evidenceSection,
				'Apply the smallest set of changes that makes replay reliable: adjust verification targets following the invariants, add settle/timeout waits around the slow transitions involved in the failures, reorder or remove steps only when the evidence supports it. Never invent selectors or URLs; keep the recorded element references, variable templates, isOptional flags, and the gate-condition + tolerant sign-in structure. Keep every step that already works unchanged.',
			]
				.filter(Boolean)
				.join('\n\n')
			const result = await generateRefinedFlow({
				flowFiles: [recording.flowFile],
				instruction,
				templates: getPromptTemplates().generation,
				...(reanchor ? { reanchor } : {}),
				runPrompt: (prompt, timeoutMs) => runPiPrompt({ prompt, cwd: flowsRoot, timeoutMs }),
			})
			if (!result.ok) {
				const error = new Error(result.error) as Error & { detail?: { stage: string; reason: string } }
				error.detail = result.detail
				throw error
			}
			return {
				// 完整已校验 Flow 一并返回：渲染层可不经拼装直接另存为新录制。
				flow: result.flow,
				steps: result.flow.steps,
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
			// recordingAdditionalPages 数组实例直接交给 recorder（保持引用共享，
			// 录制中途 windowOpenHandler/browser:createTab 追加的页面也能被看到）。
			recordingAdditionalPages = []
			recordingTabIds = [activeBrowserTabId]
			const seedPages: RrwebPageSeed[] = [
				{ page, tabId: activeBrowserTabId, label: recordingTabLabel(activeBrowserTabId) },
			]
			recordingTabSnapshots.clear()
			recordingHostEvents = []
			for (const [id, view] of browserViews) recordingTabSnapshots.set(id, { url: view.webContents.getURL(), title: view.webContents.getTitle() })
			for (const [tabId, view] of browserViews) {
				if (tabId === activeBrowserTabId) continue
				try {
					const extra = await withAbort(engine.pageFor(tabId, view.webContents), controller.signal)
					recordingAdditionalPages.push(extra)
					recordingTabIds.push(tabId)
					seedPages.push({ page: extra, tabId, label: recordingTabLabel(tabId) })
				} catch (err) {
					if (controller.signal.aborted) throw err
					console.warn(`[flowlink] 标签页 ${tabId} 未能附着：`, (err as Error).message)
				}
			}
			timing.mark('pages-attached')

			// rrweb 会话先于 recorder 建立；目录策略沿用 recording-<ts> 前缀
			// （removeRecordingFiles 的清理守卫直接兼容）。取消流程不会越过它。
			recordingCaptureRoot = join(artifactsRoot, `recording-${Date.now()}`)
			recordingPosterFile = ''
			await startRrwebRecording({
				rootDir: recordingCaptureRoot,
				pages: seedPages,
				activeTabId: activeBrowserTabId,
			})
			scheduleRecordingPoster()
			timing.mark('rrweb-installed')
			// 在 recorder 启动前再次检查取消，避免 Stop 与注入交错后仍开启录制。
			if (controller.signal.aborted) throw new RecordingStartCancelledError()

			recPromise = recordOnPage({
				page,
				pages: recordingAdditionalPages,
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
			// 首步是 navigate 时传 navigate:false，由执行器首步 goto 做唯一导航
			// （消除 loadURL 与 goto 的双导航竞态，见 resetBrowserTabs 注释）。
			const firstStepIsNavigate = flattened[0]?.step.kind === 'navigate'
			await resetBrowserTabs(flow.meta.env.startUrl, firstStepIsNavigate ? { navigate: false } : {})
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
	ipcMain.handle(
		'playback:run',
		async (
			_e,
			opts: {
				taskCode: string
				recordingId: string
				variables?: Record<string, string>
				/** AI 单步接管成功后的续跑起点（扁平下标）：>0 时保留浏览器现场、不重置标签页。 */
				resumeFromStepIndex?: number
			},
		) => {
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
		if (
			opts.resumeFromStepIndex !== undefined &&
			(!Number.isInteger(opts.resumeFromStepIndex) || opts.resumeFromStepIndex < 0)
		) {
			throw new Error('resumeFromStepIndex 无效（需为非负整数）')
		}

		const task = taskStore.get(opts.taskCode)
		const recording = task?.recordings.find((r) => r.id === opts.recordingId)
		if (!recording) throw new Error('找不到该录制')

		const flow: Flow = await loadFlow(recording.flowFile)
		const flattenedSteps = flattenSteps(flow.steps)
		// 续跑下标钳制到扁平长度（超界 = 全部 bypassed，执行器自然空转收尾）。
		const startCursor =
			opts.resumeFromStepIndex === undefined
				? 0
				: Math.min(opts.resumeFromStepIndex, flattenedSteps.length)

		if (startCursor > 0) {
			// AI 单步接管后的续跑：不 resetBrowserTabs——浏览器里的页面/标签页/登录
			// 状态就是 AI 执行完那一步后的现场，重置会毁掉它。执行器从 startCursor
			// 起步，之前步骤报 bypassed skip。
			console.log(`[playback:${flow.id}] resume from flat step ${startCursor + 1} (after AI single-step takeover)`)
		} else {
			// 每次完整测试均从录制声明的起始 URL 重新建页，而不是沿用用户当前浏览状态
			// （全新浏览器语义，见 resetBrowserTabs）。
			// 首个可执行步骤是 navigate 时传 navigate:false：执行器会跳过 startUrl
			// 导航、由首步 goto 做唯一导航——不再与本函数的 loadURL 双导航在途竞争
			// （间歇 net::ERR_ABORTED 的根因）。
			const firstStepIsNavigate = flattenedSteps[0]?.step.kind === 'navigate'
			await resetBrowserTabs(flow.meta.env.startUrl, firstStepIsNavigate ? { navigate: false } : {})
		}
		const seedPages = await attachPlaybackPages()
		// Test 运行由用户主动触发，浏览器 surface 必然位于 Test 布局。resetBrowserTabs
		// 会隐藏视图，而渲染端的 bounds 上报有几何去重、回放期间布局不变时不会重报；
		// 这里显式恢复可见（与 createNativeBrowserTab 同语义），避免整个回放期间
		// 浏览器区域空白。
		browserSurfaceVisible = true
		ensureBrowserBounds()
		syncBrowserVisibility()

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
			...(startCursor > 0 ? { startCursor } : {}),
			abortSignal: playAbortController.signal,
			waitForUserOperation: ({ stepId, prompt, signal }) =>
				hostWaitForUserOperation({ stepId, prompt, signal }),
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

			/* 更新 lastRun。
			 * assisted 循环（渲染端 runAiAssistedTest）中的 resume 失败是中间态：
			 * 不写 lastRun（失败态已由循环的初始 run 记录），避免中间失败覆盖；
			 * resume 成功即循环终态，写最终结果。非 resume 运行照写。 */
			if (startCursor === 0 || result.ok) {
				await taskStore.patchRecording(opts.taskCode, opts.recordingId, {
					lastRun: {
						ok: result.ok,
						at: new Date().toISOString(),
						pass: result.metrics.passCount,
						fail: result.metrics.failCount,
					},
				})
			}

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
		if (aiTakeoverInProgress()) {
			await abortAiTakeover()
			return true
		}
		if (!playAbortController) return false
		playAbortController.abort()
		if (playPromise) {
			const current = playPromise
			await current.catch(() => undefined)
		}
		return true
	})

	/* ---------- AI 接管续跑：Test 失败后由用户触发，browser-use 附着内嵌浏览器 ---------- */
	ipcMain.handle(
		'playback:aiContinue',
		async (
			_e,
			opts: {
				taskCode: string
				recordingId: string
				fromStepIndex: number
				/** remaining=接管剩余全部（缺省）；single=AI 单步接管（只执行失败的那一步）。 */
				mode?: 'remaining' | 'single'
				variables?: Record<string, string>
				failureSummary?: string
			},
		) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				!Number.isInteger(opts.fromStepIndex) ||
				opts.fromStepIndex < 0
			) {
				throw new Error('AI takeover request is invalid')
			}
			if (opts.mode !== undefined && opts.mode !== 'remaining' && opts.mode !== 'single') {
				throw new Error('AI takeover mode is invalid')
			}
			if (
				opts.variables !== undefined &&
				(!opts.variables ||
					typeof opts.variables !== 'object' ||
					Array.isArray(opts.variables) ||
					Object.entries(opts.variables).some(
						([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string',
					))
			) {
				throw new Error('AI 接管变量无效')
			}
			if (playPromise) throw new Error('已有回放正在进行')
			if (recPromise || recStartPromise) throw new Error('录制会话进行中，无法接管')
			if (aiTakeoverInProgress()) throw new Error('AI 接管已在进行')
			if (!engine) throw new Error('引擎未就绪（CDP 连接失败）')
			await taskStore.list()
			const task = taskStore.get(opts.taskCode)
			const recording = task?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error(`Recording not found: ${opts.recordingId}`)
			const flow = await loadFlow(recording.flowFile)
			// fire-and-forget：进度经 playback:aiStep / playback:aiDone 事件推送。
			const takeoverMode = opts.mode === 'single' ? 'single' as const : 'remaining' as const
			void startAiTakeover({
				flow,
				fromStepIndex: opts.fromStepIndex,
				mode: takeoverMode,
				variables: opts.variables ?? {},
				failureSummary:
					typeof opts.failureSummary === 'string'
						? opts.failureSummary.slice(0, 2_000)
						: undefined,
				deps: {
					cdpUrl: await engine.cdpHttpEndpoint(),
					artifactsRoot,
					modelConfig: getTakeoverModelConfig(),
					templates: getPromptTemplates().takeover,
					proxy: getPiProxyOptions(),
					resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
					evaluateGateCondition: evaluateTakeoverGate,
					waitForUserOperation: ({ stepId, prompt, signal }) =>
						hostWaitForUserOperation({ stepId, prompt, signal }),
					captureEvidence: captureTakeoverEvidence,
					onStep: (event) => {
						if (!mainWindow.isDestroyed())
							mainWindow.webContents.send('playback:aiStep', {
								...event,
								taskCode: opts.taskCode,
								recordingId: opts.recordingId,
							})
					},
					onDone: (result) => {
						if (!mainWindow.isDestroyed())
							mainWindow.webContents.send('playback:aiDone', {
								...result,
								taskCode: opts.taskCode,
								recordingId: opts.recordingId,
							})
						// lastRun 只由全量接管（remaining）收尾写入：single 是 assisted
						// 循环的中间态，最终态由循环结束时的成功 resume 或回退全量接管落。
						if (takeoverMode === 'remaining') {
							void taskStore
								.patchRecording(opts.taskCode, opts.recordingId, {
									lastRun: {
										ok: result.ok,
										at: new Date().toISOString(),
										aiAssisted: true,
										summary: result.summary,
									},
								})
								.catch((error) => {
									console.error(`[ai-takeover] lastRun 更新失败: ${(error as Error).message}`)
								})
						}
					},
				},
			}).catch((error) => {
				const message = (error as Error).message
				if (!mainWindow.isDestroyed())
					mainWindow.webContents.send('playback:aiDone', {
						ok: false,
						completed: [],
						remaining: [],
						summary: `AI takeover failed to start: ${message}`,
						artifactDir: '',
						mode: takeoverMode,
						taskCode: opts.taskCode,
						recordingId: opts.recordingId,
					})
			})
			return { started: true }
		},
	)


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
	/** 提示词模板下发：渲染层 AI 面板组装建议请求时使用（config/prompts.json）。 */
	ipcMain.handle('pi:promptTemplates', () => getPromptTemplates())

	/* ---------- Flow 读取（分析页用） ---------- */
	ipcMain.handle('flow:load', async (_e, flowFile: string) => {
		const flow: Flow = await loadFlow(flowFile)
		return flow
	})
	/**
	 * 只读 artifacts 通道：Instruction 目标查看器需要 crop 截图的 file:// URL。
	 * 返回该录制的 artifacts 根与「stepId → crop 截图 URL」列表；crop.ref 的
	 * 路径白名单校验（禁止绝对路径 / 越界）在主进程完成，渲染端不拼路径。
	 */
	ipcMain.handle(
		'recording:artifactsPath',
		async (_event, opts: { taskCode: string; recordingId: string }) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string'
			) {
				throw new Error('Artifacts request is invalid')
			}
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			// crop 可能带 sidecar（screencast 采集的整帧 + 裁剪矩形）：rect/frame
			// 一并返回，渲染端 CSS 裁剪显示；无 sidecar 的（旧数据/回退路径真裁剪）无 rect。
			const crops: Array<{
				stepId: string
				url: string
				rect?: { x: number; y: number; width: number; height: number }
				frame?: { width: number; height: number }
			}> = []
			try {
				const flow = await loadFlow(recording.flowFile)
				const root = resolve(recording.artifactsDir)
				const collect = async (steps: unknown[]) => {
					for (const raw of steps || []) {
						const step = raw as {
							id?: unknown
							steps?: unknown[]
							target?: { crop?: { ref?: unknown } }
						}
						if (Array.isArray(step.steps)) {
							await collect(step.steps)
							continue
						}
						const ref = step.target?.crop?.ref
						if (typeof step.id !== 'string' || typeof ref !== 'string' || !ref) continue
						const abs = resolve(root, ref)
						const rel = relative(root, abs)
						if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
						const crop: (typeof crops)[number] = {
							stepId: step.id,
							url: `file:///${abs.split(sep).map(encodeURIComponent).join('/')}`,
						}
						try {
							const sidecar = JSON.parse(await readFile(`${abs}.json`, 'utf8')) as {
								version?: number
								x?: unknown
								y?: unknown
								width?: unknown
								height?: unknown
								frameWidth?: unknown
								frameHeight?: unknown
							}
							if (
								sidecar.version === 1 &&
								[sidecar.x, sidecar.y, sidecar.width, sidecar.height, sidecar.frameWidth, sidecar.frameHeight]
									.every((n) => typeof n === 'number' && n >= 0)
							) {
								crop.rect = {
									x: sidecar.x as number,
									y: sidecar.y as number,
									width: sidecar.width as number,
									height: sidecar.height as number,
								}
								crop.frame = {
									width: sidecar.frameWidth as number,
									height: sidecar.frameHeight as number,
								}
							}
						} catch {
							/* 无 sidecar（旧数据/回退路径）：按整图显示 */
						}
						crops.push(crop)
					}
				}
				await collect(flow.steps as unknown[])
			} catch (error) {
				console.error(`[artifacts] 读取 crop 失败: ${(error as Error).message}`)
			}
			return { artifactsDir: recording.artifactsDir, crops }
		},
	)
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
			// 人工编辑生效前先存旧版历史快照（只存不用；写失败不阻塞保存）。
			await writeFlowHistorySnapshot(recording, flow, 'human', 'Manual edit (Process/Instruction)')
			const updated = parseFlow({
				...flow,
				version: flow.version + 1,
				steps: opts.steps,
			}, recording.flowFile)
			await saveFlow(updated, recording.flowFile, { backup: true })
			return updated
		},
	)

	/* ---------- REFINED 单线演进：pending 暂存 / 读取 / 确认 / 丢弃 ---------- */
	ipcMain.handle(
		'flow:stagePending',
		async (
			_event,
			opts: {
				taskCode: string
				recordingId: string
				source: (typeof PENDING_SOURCES)[number]
				flow: unknown
				summary?: string
				risks?: string[]
			},
		) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				typeof opts.source !== 'string' ||
				!PENDING_SOURCES.includes(opts.source as (typeof PENDING_SOURCES)[number]) ||
				!opts.flow ||
				typeof opts.flow !== 'object'
			) {
				throw new Error('待确认更新保存请求无效')
			}
			await taskStore.list()
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			// 分流守卫：pending 只面向 REFINED（isRefined）记录；原始 Record 必须走另存新纪录路径。
			if (!recording.isRefined) throw new Error('原始录制不适用待确认更新（请走另存新纪录路径）')
			const current = await loadFlow(recording.flowFile)
			// 与 saveFlow 同一约束：先完整校验再落盘；单槽设计，新 pending 覆盖旧 pending。
			const flow = parseFlow(opts.flow, pendingPathOf(recording))
			const existedBefore = !!(await readPending(recording))
			const createdAt = new Date().toISOString()
			const pending: FlowPending = {
				version: 1,
				createdAt,
				source: opts.source,
				flow,
				summary: typeof opts.summary === 'string' ? opts.summary : '',
				risks: Array.isArray(opts.risks)
					? opts.risks.filter((risk): risk is string => typeof risk === 'string')
					: [],
				baseVersion: current.version,
			}
			await writeJsonAtomic(pendingPathOf(recording), pending)
			await taskStore.patchRecording(opts.taskCode, opts.recordingId, {
				pendingUpdate: { at: createdAt, source: opts.source },
			})
			if (!mainWindow.isDestroyed()) {
				mainWindow.webContents.send('ai:pending', {
					taskCode: opts.taskCode,
					recordingId: opts.recordingId,
					at: createdAt,
					source: opts.source,
				})
			}
			return { createdAt, source: opts.source, baseVersion: current.version, overwrote: existedBefore }
		},
	)

	ipcMain.handle(
		'flow:loadPending',
		async (_event, opts: { taskCode: string; recordingId: string }) => {
			if (!opts || typeof opts.taskCode !== 'string' || typeof opts.recordingId !== 'string') {
				throw new Error('待确认更新读取请求无效')
			}
			await taskStore.list()
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			return readPending(recording)
		},
	)

	ipcMain.handle(
		'flow:confirmPending',
		async (_event, opts: { taskCode: string; recordingId: string }) => {
			if (!opts || typeof opts.taskCode !== 'string' || typeof opts.recordingId !== 'string') {
				throw new Error('待确认更新确认请求无效')
			}
			await taskStore.list()
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			const pending = await readPending(recording)
			if (!pending) throw new Error('当前没有待确认的流程更新')
			const current = await loadFlow(recording.flowFile)
			if (pending.baseVersion !== current.version) {
				throw new Error(
					`待确认版本基于 v${pending.baseVersion} 生成，当前流程已是 v${current.version}（生成后有新的修改生效）。请重新生成。`,
				)
			}
			const updated = await persistFlowUpdate(
				recording,
				pending.flow,
				pending.source === 'takeover-repair' ? 'repair-apply' : 'refine-apply',
				pending.summary || `Confirm ${pending.source} pending update`,
			)
			// pending 文件与标记同生同灭；清理失败只记日志（残留 pending 会因
			// baseVersion 落后被 Confirm 拒绝并提示重新生成，用户可 Discard 兜底）。
			try {
				await rm(pendingPathOf(recording), { force: true })
				await taskStore.patchRecording(opts.taskCode, opts.recordingId, { pendingUpdate: undefined })
			} catch (error) {
				console.warn(`[flowlink] pending 清理失败（忽略）: ${(error as Error).message}`)
			}
			return updated
		},
	)

	ipcMain.handle(
		'flow:discardPending',
		async (_event, opts: { taskCode: string; recordingId: string }) => {
			if (!opts || typeof opts.taskCode !== 'string' || typeof opts.recordingId !== 'string') {
				throw new Error('待确认更新丢弃请求无效')
			}
			await taskStore.list()
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			await rm(pendingPathOf(recording), { force: true })
			await taskStore.patchRecording(opts.taskCode, opts.recordingId, { pendingUpdate: undefined })
			return true
		},
	)

	/* ---------- 接管修复直落盘：不产生 pending，version+1 即刻生效 ---------- */
	ipcMain.handle(
		'flow:directUpdate',
		async (
			_event,
			opts: { taskCode: string; recordingId: string; flow: unknown; summary?: string },
		) => {
			if (
				!opts ||
				typeof opts.taskCode !== 'string' ||
				typeof opts.recordingId !== 'string' ||
				!opts.flow ||
				typeof opts.flow !== 'object'
			) {
				throw new Error('流程直落盘请求无效')
			}
			await taskStore.list()
			const recording = taskStore.get(opts.taskCode)?.recordings.find((item) => item.id === opts.recordingId)
			if (!recording) throw new Error('找不到该录制')
			if (!recording.isRefined) throw new Error('原始录制不适用直落盘（请走 REPAIRED- 另存路径）')
			// 先完整校验再生效；不做 baseVersion 校验（修复以最新现场为准，历史快照兜底回滚）。
			const flow = parseFlow(opts.flow, recording.flowFile)
			return persistFlowUpdate(
				recording,
				flow,
				'repair-apply',
				typeof opts.summary === 'string' && opts.summary.trim()
					? opts.summary
					: 'Takeover repair direct update',
			)
		},
	)
}
