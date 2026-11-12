/**
 * record() —— 录制流程编排。
 *
 * 时序（每一步都有明确理由）：
 *
 *   loadProfile(storageStatePath)                       ← 登录态（读失败=没登录态，不报错）
 *   launch chromium → newContext(viewport, storageState) → exposeBinding('__rrEmit') + addInitScript(capture.js)
 *   → goto(startUrl) → 抓初始签名 sig0
 *   → 事件进 buffer
 *   → 每 100ms tick：距最后一个事件 ≥ 500ms 就把 buffer 拿去合流（coalesceEvents）
 *   → 每个动作：等稳定点（连续 2 帧布局不变 + 300ms 静默）
 *              → 用 uid 把元素找回来看「最新事实」
 *              → ariaSnapshot 拿 role/name
 *              → 候选逐个 locator 校验（count===1 && visible && 命中确实是它）
 *              → 生成 ElementRef（含 fingerprint/stableHash/crop 截图）
 *              → expect = inferExpect(前一步签名, 当前签名)
 *   → stop（drive resolve / stopSignal / Ctrl+C）→ 冲掉最后一批 → 落 flow.json（写前 zod 校验）
 *
 * 本模块持有录制会话，也是唯一把动作转换为 schema Step 的层。采集回调同步追加事件队列；
 * 慢速截图、locator 校验或页面稳定等待则在独立串行队列中处理，避免批次重排或事件丢失。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { SCHEMA_VERSION, makeId, saveFlow } from '../../schema/src/index.js'
import type {
	Candidate,
	ElementRef,
	Expect,
	Flow,
	FrameAnchor,
	FramePath,
	FrameSegment,
	Step,
	Variable,
} from '../../schema/src/index.js'
import type { BrowserContext, CDPSession, Frame, Locator, Page } from 'playwright-core'

import {
	clearUids,
	describeElement,
	EMPTY_DESCRIPTION,
	ensureCaptureInPage,
	installCapture,
	installCaptureOnPage,
	locateByUid,
	normalizeEmitPayload,
	readFactsByUid,
	readFactsFromHandle,
	screenshotRegion,
	snapshotPage,
	validateCandidates,
} from './capture-client.js'
/**
 * esbuild/tsx keepNames 垫片：页面内函数被 page.evaluate 序列化后，若函数体里带
 * `__name(...)` 调用，页面里没有该全局就会 ReferenceError。纯字符串，不经过编译。
 */
const NAME_KEEPALIVE_SOURCE = 'globalThis.__name = globalThis.__name || ((fn) => fn); true'
import { coalesceEvents } from './coalesce.js'
import { compileAuthMatchers, isAuthUrl, AUTO_NAVIGATION_TYPES } from './classify.js'
import { buildElementRef, deriveCandidates } from './element.js'
import { appearedNodes, inferExpect, pickExpectTarget, urlPattern } from './expect.js'
import { describeStorageState, loadProfile, saveProfile, type ProfileShape, type StorageState } from './profile.js'
import { resolveSystem } from './systems.js'
import {
	downloadFilenamePattern,
	findDownloadFor,
	HOVER_WAIT_MS,
	insertDialogs,
	isMeaningfulHover,
	pageIndexOf,
	refineSteps,
	synthesizeOptionalNavigations,
	uploadVariableName,
	withTabSwitches,
} from './plan.js'
import type {
	CoalescedAction,
	PageSignature,
	PlannedItem,
	RawEvent,
	RecordOptions,
	RecordResult,
	RecordedDialog,
	RecordedDownload,
	SignatureNode,
} from './types.js'

const RECORDER_NAME = '@rr/recorder'
const RECORDER_VERSION = '0.1.0'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const DEFAULT_BUFFER_MS = 500
const DEFAULT_SETTLE_SILENCE_MS = 300
/** 稳定判定：连续多少帧布局不变 */
const STABLE_FRAMES = 2
/** 稳定等待上限：页面永远在动也要往下走，绝不把录制卡死 */
const MAX_SETTLE_MS = 5000
/** 每多少毫秒检查一次 buffer 是否可以冲 */
const TICK_MS = 100
/** 动作进行中周期性采样页面签名（用于把 expect 正确归因到动作） */
const SIGNATURE_INTERVAL_MS = 120
/** hover 步骤推断 expect 时往前回看的窗口（覆盖 350ms 停留 + 采样抖动） */
const HOVER_LOOKBACK_MS = 600
/** 采样上限，防止长录制把内存吃掉 */
const MAX_SIGNATURE_SAMPLES = 600

function newURLSafeHost(value: string): string { try { return new URL(value).host.toLowerCase() } catch { return '' } }
const URLSafeHost = newURLSafeHost

/** 正常结束但没有任何可回放步骤：调用方应静默取消，而不是写一份非法的空 flow。 */
export class EmptyRecordingError extends Error {
	constructor() {
		super('录制未捕获任何步骤，未生成 recording')
		this.name = 'EmptyRecordingError'
	}
}

/** 初始化阶段的页面/CDP 调用也必须响应 Stop，不能等到 stopPromise 创建后才可取消。 */
function withRecordingStop<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise
	if (signal.aborted) return Promise.reject(new EmptyRecordingError())
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', onAbort)
		const onAbort = () => {
			cleanup()
			reject(new EmptyRecordingError())
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

export async function record(opts: RecordOptions): Promise<RecordResult> {
	const viewport = opts.viewport ?? DEFAULT_VIEWPORT
	const headless = opts.headless ?? false
	const bufferMs = opts.bufferMs ?? DEFAULT_BUFFER_MS
	const silenceMs = opts.settleSilenceMs ?? DEFAULT_SETTLE_SILENCE_MS
	const artifactsRoot = resolve(opts.artifactsRoot ?? './artifacts')
	// 认证 URL 匹配器编译一次全程复用（始终使用编译进代码的内置规则）。
	const authMatchers = compileAuthMatchers()
	const flowId = makeId('flow')
	const artifactsDir = join(artifactsRoot, flowId)
	const elementsDir = join(artifactsDir, 'record', 'elements')
	/** 懒创建：录制失败或 0 步时不该留下空目录 */
	let elementsDirReady = false
	let screenshotsDirReady = false
	const screenshotsDir = join(artifactsDir, 'record', 'screenshots')
	const ensureScreenshotsDir = async (): Promise<void> => {
		if (screenshotsDirReady) return
		await mkdir(screenshotsDir, { recursive: true })
		screenshotsDirReady = true
	}
	const ensureElementsDir = async (): Promise<void> => {
		if (elementsDirReady) return
		await mkdir(elementsDir, { recursive: true })
		elementsDirReady = true
	}

	/* ---------------- 采集通道状态 ---------------- */

	// pending 是尚未合流的工作队列，flush 会按批取走；allEvents 仅是有界诊断副本，
	// 不能作为生成 Step 的来源，否则会重复处理已消费事件，也可能截断超过上限的录制。
	const pending: RawEvent[] = []
	const allEvents: RawEvent[] = []
	const warnings: string[] = []
	warnings.push(...authMatchers.warnings)
	let lastEventTs = Date.now()
	let rawEventSequence = 0

	/** 标签页序号：按 Page 创建顺序，0 = 录制起点（任务要求 index=0 可省略） */
	const pageIndexes = new WeakMap<Page, number>()
	const pagesByIndex = new Map<number, Page>()
	let pageSeq = 0
	const ensurePageIndex = (target: Page): number => {
		const existing = pageIndexes.get(target)
		if (existing !== undefined) return existing
		const index = pageSeq++
		pageIndexes.set(target, index)
		pagesByIndex.set(index, target)
		return index
	}

	/** 录制期的旁路事件（不来自页面事件流）：原生对话框 / 下载 */
	const dialogs: RecordedDialog[] = []
	const downloads: RecordedDownload[] = []
	const consumedDialogs = new Set<RecordedDialog>()
	const consumedDownloads = new Set<RecordedDownload>()

	const frameIndexes = new WeakMap<Frame, number>()
	const framesByIndex = new Map<number, Frame>()
	let frameSeq = 0
	const ensureFrameIndex = (frame: Frame): number => {
		const existing = frameIndexes.get(frame)
		if (existing !== undefined) return existing
		const index = frameSeq++
		frameIndexes.set(frame, index)
		framesByIndex.set(index, frame)
		return index
	}
	const navigationReadyByPage = new WeakSet<Page>()
	const lastNavigationUrlByPage = new WeakMap<Page, string>()

	/* ---------------- 录制产物状态 ---------------- */

	const steps: Step[] = []
	const variables = new Map<string, Variable>()
	let stepSeq = 0
	/** 上传文件占位变量序号：file_1 / file_2 … */
	let uploadSeq = 0
	let inputSeq = 0
	/** 每个标签页最近一次签名（expect 推断的兜底 before） */
	const lastSigByPage = new Map<number, PageSignature>()
	/** 页面签名时间线：多标签页各自打点，按 pageIndex 过滤使用 */
	const samples: Array<{ ts: number; pageIndex: number; sig: PageSignature }> = []
	let recordingActive = true

	/** 当前动作所在标签页；openTab 本身也会切换当前页。 */
	const tabState = { page: 0 }
	const openedTabIndexes = new Set<number>()

	/** 给 step 打标签页标记：index 0 可省略（回放默认从起点页开始） */
	const markPage = (step: Step, index: number): Step =>
		index > 0 ? ({ ...step, page: { index } } as Step) : step

	/** 推入一条 step（带 page 标记 + onStep 回调；回调抛错不影响录制） */
	const pushStep = (step: Step, pageIndex: number, sourceEvents: RawEvent[] = []): void => {
		const sourcePage = pagesByIndex.get(pageIndex)
		let pageUrl = opts.startUrl
		try { pageUrl = sourcePage?.url() || opts.startUrl } catch {}
		const { systemId, systemName } = resolveSystem(pageUrl, opts.systemAliases)
		const locatorEvidence = 'target' in step && step.target ? step.target.candidates : undefined
		const enriched = { ...step, tabId: opts.tabIds?.[pageIndex] ?? `page-${pageIndex}`, systemId, systemName, pageUrl, ...(sourceEvents.length ? { sourceEventIds: sourceEvents.map(event => event.eventId).filter((id): id is string => Boolean(id)) } : {}), ...(locatorEvidence ? { locatorEvidence } : {}) } as Step
		const marked = markPage(enriched, pageIndex)
		steps.push(marked)
		if (!opts.onStep) return
		try {
			opts.onStep(marked)
		} catch (err) {
			warnings.push(`onStep 回调抛错：${(err as Error).message}`)
		}
	}

	const primeNavigation = (target: Page): void => {
		navigationReadyByPage.add(target)
		lastNavigationUrlByPage.set(target, target.url())
	}

	/** 录制开始后创建的标签页：openTab 自己就是切页动作，不需要再补 switchTab。 */
	const recordOpenedTab = (target: Page, knownIndex?: number): void => {
		if (!recordingActive) return
		const index = knownIndex ?? ensurePageIndex(target)
		if (index <= 0 || openedTabIndexes.has(index)) return
		const hostOwnsOpenEvent = opts.hostEvents?.some(
			(event) =>
				event.action === 'tabCreated' &&
				event.tabId === opts.tabIds?.[index],
		)
		if (hostOwnsOpenEvent) return
		openedTabIndexes.add(index)
		const openUrl = target.url()
		pushStep(
			{
				kind: 'openTab',
				id: `s${++stepSeq}`,
				...(openUrl && openUrl !== 'about:blank' ? { url: openUrl } : {}),
			},
			index,
		)
		tabState.page = index
	}

	/* ---------------- 登录态（storageState profile） ---------------- */

	const profile = await loadProfile(opts.storageStatePath)
	if (profile.status === 'missing' || profile.status === 'invalid') {
		// 读失败不是错误：这次就当没登录态录，录完照常可以用 saveStorageStatePath 存一份新的
		warnings.push(profile.message ?? '登录态读取失败，按未登录状态录制')
	}
	if (profile.status === 'loaded') warnings.push(`已加载登录态：${describeStorageState(profile.state)}`)
	const profileShape: ProfileShape = profile.shape ?? 'raw'
	const profileOrigin = profile.origin

	const existingPage = opts.page
	const additionalPages = opts.pages ?? []
	const attachOnly = opts.attachOnly === true || Boolean(existingPage)
	const ownsBrowser = !existingPage
	/** CDP 附着时 browser() 可能为 null，后续只能走 existingPage 路径；
	    独立录制才需要启动 Chromium，动态导入避免拖慢 Electron 使用方启动。 */
	const browser = existingPage
		? existingPage.context().browser()
		: await (await import('playwright-core')).chromium.launch({ headless })
	/**
	 * context 的「外层引用」：try/finally 里要做「兜底保存登录态」
	 * （drive 抛错 / goto 失败 / 任何异常路径都要存一次）。
	 * 用单独变量而不是把 const context 提出来，是为了不破坏 try 内部已有的类型收窄。
	 */
	let contextRef: BrowserContext | undefined
	let savedProfile = false
	/**
	 * 把当前登录态写回 saveStorageStatePath（幂等，只写一次）。
	 * 失败只告警：profile 是增强项，不该影响 flow 落盘。
	 */
	const persistStorageState = async (): Promise<void> => {
		const activeContext = contextRef
		if (savedProfile || !opts.saveStorageStatePath || !activeContext) return
		savedProfile = true
		let state: StorageState
		try {
			state = await activeContext.storageState()
		} catch (err) {
			warnings.push(`保存登录态失败（读取 storageState）：${(err as Error).message}`)
			return
		}
		const result = await saveProfile(opts.saveStorageStatePath, state, {
			shape: profileShape,
			origin: profileOrigin,
		})
		if (result.ok) warnings.push(`已保存登录态：${describeStorageState(state)} → ${result.path}`)
		else warnings.push(`保存登录态失败（${opts.saveStorageStatePath}）：${result.error}`)
	}

	const enqueueRawEvent = (sourcePage: Page, frame: Frame, event: RawEvent): void => {
		// 先在同步回调内确定 frame/page 归属并入队；之后的异步 DOM 处理不再推测事件来源。
		event.frameIndex = ensureFrameIndex(frame)
		// 多标签页归属：binding 回调的 source.page 才是可靠来源（frame 会跨页，页面内也看不到 tab 身份）
		const pageIndex = ensurePageIndex(sourcePage)
		event.eventId = event.eventId ?? `event-${++rawEventSequence}`
		event.pageIndex = pageIndex
		event.tabId = opts.tabIds?.[pageIndex] ?? `page-${pageIndex}`
		const sourceUrl = sourcePage.url()
		const { systemId, systemName } = resolveSystem(sourceUrl, opts.systemAliases)
		event.systemId = systemId
		event.systemName = systemName
		lastEventTs = event.ts
		pending.push(event)
		// 完整证据副本有较高上限；不反过来限制执行 IR 的生成队列。
		if (allEvents.length < 100_000) allEvents.push(event)
		else if (allEvents.length === 100_000) warnings.push('Raw evidence archive reached 100,000 events; later raw events are omitted from the sidecar.')
	}

	const onEmit = (sourcePage: Page, frame: Frame, payload: unknown): void => {
		const event = normalizeEmitPayload(payload)
		if (!event) return
		enqueueRawEvent(sourcePage, frame, event)
	}

	try {
		let context: BrowserContext
		let page: Page
		if (existingPage) {
			context = existingPage.context()
			contextRef = context
			page = existingPage
			// keepNames 垫片：页面内采集/校验函数会经 page.evaluate 序列化
			await withRecordingStop(
				page.addInitScript({ content: NAME_KEEPALIVE_SOURCE }).catch(() => {}),
				opts.stopSignal,
			)
			await withRecordingStop(page.evaluate(NAME_KEEPALIVE_SOURCE).catch(() => {}), opts.stopSignal)
			if (attachOnly) {
				// Electron CDP context 里还有产品壳页面，禁止 context 级 addInitScript
				await withRecordingStop(installCaptureOnPage(page, onEmit), opts.stopSignal)
				for (const additionalPage of additionalPages) {
					if (additionalPage === page || additionalPage.isClosed()) continue
					await withRecordingStop(
						additionalPage.addInitScript({ content: NAME_KEEPALIVE_SOURCE }).catch(() => {}),
						opts.stopSignal,
					)
					await withRecordingStop(
						additionalPage.evaluate(NAME_KEEPALIVE_SOURCE).catch(() => {}),
						opts.stopSignal,
					)
					await withRecordingStop(installCaptureOnPage(additionalPage, onEmit), opts.stopSignal)
				}
			} else {
				await withRecordingStop(context.addInitScript({ content: NAME_KEEPALIVE_SOURCE }), opts.stopSignal)
				await withRecordingStop(installCapture(context, onEmit), opts.stopSignal)
			}
		} else {
			if (!browser) throw new Error('chromium.launch() 未返回 browser')
			const baseContextOptions = { viewport, deviceScaleFactor: 1 }
			try {
				context = await browser.newContext({
					...baseContextOptions,
					// 没有登录态时不要传 storageState（显式空对象会被 Playwright 判为非法）
					...(profile.state ? { storageState: profile.state } : {}),
				})
			} catch (err) {
				// profile 只是「省一次登录」的增强，不能因为它让整场录制开不起来：
				// 形状合法但内容被 Playwright 判非法（如过期的 sameSite 枚举、坏 domain）时，
				// 丢掉登录态重试一次，并在告警里说清楚。
				if (!profile.state) throw err
				warnings.push(
					`登录态无法被浏览器接受，本次按未登录录制：${(err as Error).message.split('\n')[0]}`,
				)
				context = await browser.newContext(baseContextOptions)
			}
			contextRef = context
			// keepNames 垫片：页面内采集/校验函数会经 page.evaluate 序列化，esbuild 注入的 __name 在页面里不存在
			await context.addInitScript({ content: NAME_KEEPALIVE_SOURCE })
			await installCapture(context, onEmit)
			page = await context.newPage()
		}

		/**
		 * 给每个标签页挂监听：
		 * - dialog：**必须立刻 accept**，否则原生弹窗把页面卡住、录制直接死；
		 *   同时记一条旁路事件，成步时插到触发它的那一步之后。
		 * - download：记下来给触发它的那一步补 `expect: {kind:'download'}`。
		 * - page：popup / target=_blank 新开的标签页，按创建顺序拿 index。
		 */
		const wiredPages = new WeakSet<Page>()
		const attachPageListeners = (target: Page): void => {
			// context.on('page') 对 context.newPage() 也会触发，必须去重：
			// 否则 dialog 会被 accept 两次、记录成两条 dialog 步骤（实测踩过）
			if (wiredPages.has(target)) return
			wiredPages.add(target)

			/**
			 * 兜底注入：popup 的首个真实文档拿不到 context 级 initScript（实测），
			 * 所以每个页面在「创建时 / domcontentloaded / 主 frame 导航后」各补一次。
			 * capture.js 用 document 级标记去重，重复调用是安全的。
			 */
			const reinjectCapture = (): void => {
				void ensureCaptureInPage(target).catch(() => {})
			}
			reinjectCapture()
			target.on('domcontentloaded', reinjectCapture)
			target.on('frameattached', reinjectCapture)
			target.on('framenavigated', (frame) => {
				if (frame === target.mainFrame()) reinjectCapture()
				else void ensureCaptureInPage(target).catch(() => {})
				if (frame !== target.mainFrame()) return
				const url = frame.url()
				if (!navigationReadyByPage.has(target)) {
					if (url) lastNavigationUrlByPage.set(target, url)
					return
				}
				const previousUrl = lastNavigationUrlByPage.get(target)
				if (!url || url === previousUrl) return
				lastNavigationUrlByPage.set(target, url)
				const now = Date.now()
				const pageIndex = ensurePageIndex(target)
				const tabId = opts.tabIds?.[pageIndex]
				const recent = allEvents
					.filter((item) => item.pageIndex === pageIndex && item.kind === 'click' && now - item.ts >= 0 && now - item.ts < 2500)
					.at(-1)
				const clickedHref = recent?.facts?.attributes?.href
				const manualRequest = tabId
					? [...(opts.hostEvents ?? [])].reverse().find((event) =>
							event.action === 'userNavigateRequested' &&
							event.tabId === tabId &&
							event.url === url &&
							now - event.ts >= 0 &&
							now - event.ts <= 30_000,
						)
					: undefined
				let navigationType: RawEvent['navigationType'] = 'unknown_navigation'
				const evidence: string[] = []
				if (!previousUrl) { navigationType = 'initial'; evidence.push('no-previous-url') }
				else if (manualRequest) {
					navigationType = 'user_navigate'
					evidence.push('explicit-browser-address-bar-request')
				} else if (clickedHref) {
					try {
						const expected = new URL(clickedHref, previousUrl).href
						if (expected === url || new URL(expected).origin === new URL(url).origin) { navigationType = 'user_link'; evidence.push('recent-click-href-match') }
						else if (isAuthUrl(url, authMatchers)) { navigationType = 'sso_redirect'; evidence.push('recent-click-followed-by-auth-url') }
					} catch {}
				}
				if (navigationType === 'unknown_navigation' && isAuthUrl(url, authMatchers)) { navigationType = isAuthUrl(previousUrl || '', authMatchers) ? 'login_redirect' : 'sso_redirect'; evidence.push('authentication-url-heuristic') }
				if (navigationType === 'unknown_navigation' && previousUrl && URLSafeHost(previousUrl) !== URLSafeHost(url)) evidence.push('cross-host-navigation-without-matched-user-click')
				if (navigationType === 'unknown_navigation') evidence.push('cause-not-observable-from-page-event')
				// 认证类重定向同样入队：observed 证据不可丢。可执行侧由 processBatch 在
				// coalesceEvents 之前把 AUTO_NAVIGATION_TYPES 事件单独合成为 isOptional
				// 的 navigate 步骤，保证进入合流器的事件流与历史行为一致。
				enqueueRawEvent(target, frame, {
					kind: 'navigation',
					ts: now,
					frameUrl: url,
					url,
					previousUrl,
					directNavigation: !['initial', 'sso_redirect', 'login_redirect', 'auto_redirect'].includes(navigationType),
					navigationType,
					navigationEvidence: evidence,
				})
			})

			target.on('dialog', (dialog) => {
				const pageIndex = ensurePageIndex(target)
				const type = dialog.type()
				const promptText = type === 'prompt' ? dialog.defaultValue() : undefined
				dialogs.push({ ts: Date.now(), pageIndex, action: 'accept', ...(promptText === undefined ? {} : { promptText }) })
				// accept(defaultValue)：让录制继续；prompt 的真实用户输入拿不到，只能记默认值
				void dialog.accept(promptText).catch(() => {})
				warnings.push(`录制期处理了原生 ${type} 对话框（已 accept）：${dialog.message().slice(0, 120)}`)
			})
			target.on('download', (download) => {
				downloads.push({
					ts: Date.now(),
					pageIndex: ensurePageIndex(target),
					filename: download.suggestedFilename(),
				})
			})
			target.on('close', () => {
				const pageIndex = pageIndexes.get(target)
				if (pageIndex !== undefined && pageIndex > 0 && recordingActive) {
					pushStep({ kind: 'closeTab', id: `s${++stepSeq}`, index: pageIndex }, pageIndex)
				}
			})
		}

		// 新标签页需要纳入全局事件流。附着 Electron 模式下只接受网页 / about:blank
		// target，明确排除 file:// 产品壳层，避免 FlowLink UI 污染业务 pageIndex。
		context.on('page', (opened) => {
			const accept = !attachOnly || /^(https?:|about:blank)/i.test(opened.url())
			if (!accept) return
			const idx = ensurePageIndex(opened)
			attachPageListeners(opened)
			if (idx > 0) recordOpenedTab(opened, idx)
			if (attachOnly) {
				void installCaptureOnPage(opened, onEmit).catch((err) => {
					warnings.push(`新标签页采集脚本安装失败（page ${idx}）：${(err as Error).message}`)
				})
			}
		})

		ensurePageIndex(page)
		attachPageListeners(page)
		for (const additionalPage of additionalPages) {
			if (additionalPage === page || additionalPage.isClosed()) continue
			ensurePageIndex(additionalPage)
			attachPageListeners(additionalPage)
		}
		if (!opts.skipNavigate) {
			await withRecordingStop(
				page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
				opts.stopSignal,
			)
			await withRecordingStop(page.waitForLoadState('load').catch(() => {}), opts.stopSignal)
		} else {
			await withRecordingStop(
				page.waitForLoadState('domcontentloaded').catch(() => {}),
				opts.stopSignal,
			)
		}

		const dpr = await withRecordingStop(
			page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1),
			opts.stopSignal,
		)
		const startUrl = page.url()
		for (const target of pagesByIndex.values()) {
			if (target.isClosed()) continue
			primeNavigation(target)
		}
		const syncFrames = () => {
			for (const target of pagesByIndex.values()) {
				if (!target.isClosed()) for (const frame of target.frames()) ensureFrameIndex(frame)
			}
		}
		syncFrames()
		// 初始签名：第一个动作的「before」
		await withRecordingStop(settleFrameStability(page).catch(() => {}), opts.stopSignal)
		lastSigByPage.set(
			0,
			await withRecordingStop(snapshotPage(page, ensureFrameIndex), opts.stopSignal),
		)

		/* ---------- CDP：判断点击目标有没有 closed shadow root ----------
		 * Spike A 结论：closed shadow 内部对页面 JS / Playwright locator / aria 都不可见，
		 * 唯一可靠的判定是 CDP `DOM.describeNode(host).shadowRoots[].shadowRootType`。
		 * 命中时录制为「host 的 ElementRef + innerOffset」，回放用 host.click({position})。
		 */
		/** 每个标签页一份 CDP session（DOM 查询是 per-document 的） */
		const cdpByPage = new WeakMap<Page, { session: CDPSession; rootNodeId?: number }>()
		const ensureCdp = async (
			target: Page,
		): Promise<{ session: CDPSession; rootNodeId?: number }> => {
			let entry = cdpByPage.get(target)
			if (!entry) {
				const session = await context.newCDPSession(target)
				await session.send('DOM.enable')
				entry = { session }
				cdpByPage.set(target, entry)
			}
			return entry
		}
		const hasClosedShadowRoot = async (target: Page, uid: string): Promise<boolean> => {
			try {
				const entry = await ensureCdp(target)
				if (entry.rootNodeId === undefined) {
					const doc = await entry.session.send('DOM.getDocument', { depth: 0 })
					entry.rootNodeId = doc.root.nodeId
				}
				const { nodeId } = await entry.session.send('DOM.querySelector', {
					nodeId: entry.rootNodeId!,
					selector: `[data-rr-uid="${uid}"]`,
				})
				if (!nodeId) return false
				const described = await entry.session.send('DOM.describeNode', {
					nodeId,
					depth: 1,
					pierce: false,
				})
				const roots =
					(described.node as { shadowRoots?: Array<{ shadowRootType?: string }> }).shadowRoots ?? []
				return roots.some((root) => root.shadowRootType === 'closed')
			} catch {
				// 文档切换 / 节点消失：重置该页缓存，下次重试
				const entry = cdpByPage.get(target)
				if (entry) entry.rootNodeId = undefined
				return false
			}
		}

		/** 动作所属的页面（pageIndex 缺省 = 0，即录制起点页） */
		const pageOfAction = (action: CoalescedAction): Page =>
			pagesByIndex.get(pageIndexOf(action, 0)) ?? page

		/* ---------- 单个动作 → Step ---------- */

		const buildRefFor = async (
			action: CoalescedAction,
			elementKey: number | string,
		): Promise<ElementRef | undefined> => {
			const baseFacts = action.facts
			if (!baseFacts) return undefined
			const actionPage = pageOfAction(action)
			const frame = framesByIndex.get(action.frameIndex ?? 0) ?? actionPage.mainFrame()
			const uid = baseFacts.uid

			// baseFacts 是事件发生时的兜底快照；仍能通过 UID 找到节点时，优先刷新位置与属性。
			// 找不到则保留原始事实，确保短暂弹出的目标不会因后续消失而丢失。
			let facts = baseFacts
			let locator: Locator | undefined
			if (uid) {
				locator = await locateByUid(frame, uid)
				if (locator) {
					// 元素可能已经移动/属性变了：录完的「最新事实」才是回放时的样子
					const fresh = await readFactsByUid(frame, uid)
					if (fresh) facts = { ...fresh, uid }
				}
			}

			const described = locator ? await describeElement(locator).catch(() => EMPTY_DESCRIPTION) : {}
			const merged = {
				...facts,
				uid,
				role: described.role ?? baseFacts.role ?? facts.attributes['role'],
				accessibleName: described.name ?? baseFacts.accessibleName,
			}

			// closed shadow：目标实际是 host，内层元素既不可定位也不可快照，
			// 只能记 host + 相对 padding box 的偏移，回放靠 host.click({position})。
			if (action.kind === 'click' && uid) {
				const closed = await hasClosedShadowRoot(actionPage, uid)
				if (closed) {
					merged.shadowRootType = 'closed'
					if (action.offset)
						merged.innerOffset = { x: round2(action.offset.x), y: round2(action.offset.y) }
				}
			}

			const derived = deriveCandidates(merged)
			// 候选先按评分生成；只有能定位到仍存活的 UID 时才做实时校验并标记为可信。
			let accepted: Candidate[] = derived.slice(0, 4)
			let validation: 'ok' | 'detached' | 'ambiguous' | 'unvalidated' = 'detached'
			if (uid && locator) {
				const result = await validateCandidates(frame, derived, uid)
				if (result.accepted.length) {
					accepted = result.accepted
					validation = 'ok'
				} else {
					validation = 'ambiguous'
				}
			}

			// 元素裁剪图（crop.ref 相对 artifacts/<flowId>/）
			// 用非滚动截图（page.screenshot + clip）：不改变页面滚动/焦点，否则会录到"自己造成的滚动"
			let crop: ElementRef['crop']
			if (locator) {
				const ref = `record/elements/${elementKey}.png`
				await ensureElementsDir()
				const shot = await screenshotRegion(
					actionPage,
					frame,
					merged.rect ?? facts.rect,
					merged.scroll ?? facts.scroll ?? { x: 0, y: 0 },
					join(elementsDir, `${elementKey}.png`),
				)
				if (shot) {
					crop = { ref, dpr: facts.dpr ?? dpr }
				}
			}

			const elementRef = buildElementRef({
				...merged,
				candidates: accepted,
				frame: await buildFramePath(frame),
				crop,
			})
			if (validation !== 'ok') {
				// 未通过实时校验的候选仍可供人工诊断，但必须明确标注，不能伪装成已验证定位。
				const note =
					validation === 'detached'
						? '元素在录制后被销毁，候选未经校验'
						: '候选未能唯一命中，已保留启发式顺序'
				elementRef.description = `${elementRef.description ?? ''}（${note}）`.trim()
			}
			return elementRef
		}

		/**
		 * iframe 链（Spike 结论 2）：每一层都记 `frameElement` anchor + `urlPattern`，**不依赖 index**。
		 * - anchor：iframe 元素的语义身份（id/name/testid/role），跨 reload 稳定；
		 * - urlPattern：child frame 的 URL 形状，作为 anchor 失效时的第二道线索。
		 * 只有 url 是 about:blank 且拿不到 anchor 时才退化到 index。
		 */
		const buildFramePath = async (frame: Frame): Promise<FramePath> => {
			const chain: Frame[] = []
			let current: Frame | null = frame
			while (current && current.parentFrame()) {
				chain.unshift(current)
				current = current.parentFrame()
			}
			if (!chain.length) return { path: [] }
			const path: FrameSegment[] = []
			for (const child of chain) {
				const anchor = await buildFrameAnchor(child).catch(() => undefined)
				if (anchor) path.push({ kind: 'frameElement', anchor })
				const childUrl = child.url()
				if (childUrl && childUrl !== 'about:blank')
					path.push({ kind: 'urlPattern', pattern: urlPattern(childUrl) })
				if (!anchor && (!childUrl || childUrl === 'about:blank'))
					path.push({
						kind: 'index',
						index: child.parentFrame()?.childFrames().indexOf(child) ?? 0,
					})
			}
			return { path }
		}

		/**
		 * iframe 元素的 anchor：优先 id / name / testid 这类稳定身份。
		 * 复用普通元素的「打 uid → 采事实 → ariaSnapshot 取 role/name → locator 校验」链路。
		 */
		const buildFrameAnchor = async (childFrame: Frame): Promise<FrameAnchor | undefined> => {
			const parent = childFrame.parentFrame()
			if (!parent) return undefined
			const handle = await childFrame.frameElement().catch(() => null)
			if (!handle) return undefined
			try {
				const element = handle.asElement()
				if (!element) return undefined
				// 给 iframe 元素打一个临时标记，复用手普通元素完全相同的校验链路
				const uid = await element.evaluate((node) => {
					const el = node as Element
					const existing = el.getAttribute('data-rr-uid')
					if (existing) return existing
					const next = `frame_${Math.random().toString(36).slice(2, 8)}`
					el.setAttribute('data-rr-uid', next)
					return next
				})
				const facts = await readFactsFromHandle(element as any)
				if (!facts) return undefined
				const iframeLocator = parent.locator(`[data-rr-uid="${uid}"]`)
				const described = await describeElement(iframeLocator).catch(() => EMPTY_DESCRIPTION)
				const merged = { ...facts, uid, role: described.role, accessibleName: described.name }
				const derived = deriveCandidates(merged)
				const result = await validateCandidates(parent, derived, uid)
				const ref = buildElementRef({
					...merged,
					candidates: result.accepted.length ? result.accepted : derived.slice(0, 3),
				})
				return { observed: ref.observed, candidates: ref.candidates, fingerprint: ref.fingerprint }
			} finally {
				await handle.dispose().catch(() => {})
			}
		}

		/** 目标是不是 <input type=file>（回放用 setInputFiles，不用 click） */
		const isFileInput = (target: ElementRef): boolean => {
			if (target.observed.tag.toLowerCase() !== 'input') return false
			return (target.observed.attributes['type'] ?? '').toLowerCase() === 'file'
		}

		/**
		 * 上传步骤：只记「要传一个文件」，具体路径由回放时的变量提供。
		 *
		 * 为什么是占位变量：浏览器安全模型不把用户选的文件路径暴露给页面，
		 * 录制端拿不到（这是产品限制，不是实现偷懒）。同一次录制里第 N 个上传 → `file_N`。
		 */
		const buildUploadStep = (id: string, target: ElementRef): Step => {
			uploadSeq += 1
			const name = uploadVariableName(uploadSeq)
			variables.set(name, { name, type: 'file', secret: false, source: 'input' })
			return { kind: 'upload', id, target, files: [`{{${name}}}`] }
		}

		const buildStep = async (action: CoalescedAction): Promise<Step | undefined> => {
			const stepIndex = steps.length
			const id = `s${++stepSeq}`
			try {
				await ensureScreenshotsDir()
				await pageOfAction(action).screenshot({
					path: join(screenshotsDir, `step-${String(stepIndex + 1).padStart(4, '0')}.png`),
					type: 'png',
				})
			} catch {}
			if (action.kind === 'navigate') {
				// 机器跳转合成的 navigate 带 isOptional：回放时若浏览器已自行重定向则跳过
				const isOptional = AUTO_NAVIGATION_TYPES.has(action.navigationType ?? '')
				return { kind: 'navigate', id, url: action.url ?? pageOfAction(action).url(), navigationType: action.navigationType, previousUrl: action.previousUrl, navigationEvidence: action.navigationEvidence, ...(isOptional ? { isOptional: true } : {}) }
			}
			const target = await buildRefFor(action, stepIndex)
			switch (action.kind) {
				case 'click': {
					if (!target) return undefined
					// 点到 <input type=file> → 记 upload（占位变量），点本身没有回放价值：
					// 浏览器文件对话框在 Playwright 里根本打不开，回放靠 setInputFiles 填路径。
					if (isFileInput(target)) return buildUploadStep(id, target)
					const step: Step = {
						kind: 'click',
						id,
						target,
						button: action.button ?? 'left',
						clickCount: clamp(Math.round(action.clickCount ?? 1), 1, 3),
						modifiers: action.modifiers ?? [],
					}
					// closed shadow 必须带 position（schema 契约会强制检查），坐标是 CSS px
					if (target.observed.shadowRootType === 'closed' && target.observed.innerOffset)
						step.position = { ...target.observed.innerOffset }
					return step
				}
				case 'input': {
					if (!target) return undefined
					const type = target.observed.attributes['type']?.toLowerCase()
					if (action.masked || type === 'password') {
						variables.set('password', {
							name: 'password',
							type: 'secret',
							secret: true,
							source: 'input',
						})
						return { kind: 'input', id, target, value: '{{password}}', clear: true }
					}
					const name = `input_${++inputSeq}`
					variables.set(name, {
						name,
						type: 'string',
						defaultValue: action.value ?? '',
						secret: false,
						source: 'input',
					})
					return { kind: 'input', id, target, value: `{{${name}}}`, clear: true }
				}
				case 'select': {
					if (!target) return undefined
					const values = action.selectedValues?.length
						? action.selectedValues
						: action.value !== undefined
							? [action.value]
							: []
					return {
						kind: 'select',
						id,
						target,
						value: values.length > 1 ? values : (values[0] ?? ''),
					}
				}
				case 'key': {
					const key = action.key ?? 'Enter'
					const modifiers = action.modifiers?.length ? action.modifiers : undefined
					if (!target) return { kind: 'key', id, key, ...(modifiers ? { modifiers } : {}) }
					return { kind: 'key', id, key, target, ...(modifiers ? { modifiers } : {}) }
				}
				case 'hover': {
					// hover 到这里时已经过意义过滤（aria-haspopup / 后面 2s 内点了别的元素）
					if (!target) return undefined
					return { kind: 'hover', id, target }
				}
				case 'drag': {
					// 起点与终点各建一个 ElementRef；crop 用 -from/-to 后缀避免互相覆盖。
					// 任一侧无法复核（无稳定 UID / 元素已消失）就不成步：伪造坐标回放必错，
					// 原始 dragStart/drop 事件仍在证据流里。
					const from = await buildRefFor({ ...action, facts: action.from }, `${stepIndex}-from`)
					const to = await buildRefFor({ ...action, facts: action.to }, `${stepIndex}-to`)
					if (!from || !to) {
						warnings.push('拖拽动作的起点/终点元素无法复核，已保留为证据（不生成 drag 步骤）')
						return undefined
					}
					return { kind: 'drag', id, from, to: { target: to } }
				}
				case 'scroll': {
					const delta = { x: Math.round(action.delta?.x ?? 0), y: Math.round(action.delta?.y ?? 0) }
					return target ? { kind: 'scroll', id, target, delta } : { kind: 'scroll', id, delta }
				}
				default:
					return undefined
			}
		}

		/* ---------- expect 推断：把「新出现的元素」变回 ElementRef ---------- */

		const takeExpect = async (
			before: PageSignature,
			after: PageSignature,
		): Promise<Expect | undefined> => {
			if (after.url !== before.url) return { kind: 'urlChange', pattern: urlPattern(after.url) }
			const appeared = appearedNodes(before, after)
			const picked = pickExpectTarget(appeared)
			if (!picked) return undefined
			const frame = framesByIndex.get(picked.frameIndex ?? 0)
			// 优先用 uid 把元素找回来做完整校验（候选可靠）；
			// 找不到（菜单已收起 / toast 已消失）就用快照里的事实兜底重建，
			// 否则「悬停展开的菜单」这种瞬时元素永远推不出 expect，回放时下一步必 HIDDEN。
			// 先走 UID 实时链路以取得已校验候选；节点消失后再用有界快照事实重建，保留瞬态 UI 预期。
			let ref = picked.uid && frame ? await buildRefFromUid(frame, picked.uid) : undefined
			if (!ref) ref = await buildRefFromSnapshotNode(picked, frame)
			if (!ref) return undefined
			picked.ref = ref
			// inferExpect 内部会重新挑一次（同输入同输出，必然仍选中 picked）
			return inferExpect(before, after)
		}

		const buildRefFromUid = async (frame: Frame, uid: string): Promise<ElementRef | undefined> => {
			const locator = await locateByUid(frame, uid)
			if (!locator) return undefined
			const facts = await readFactsByUid(frame, uid)
			if (!facts) return undefined
			const described = await describeElement(locator).catch(() => EMPTY_DESCRIPTION)
			const merged = { ...facts, uid, role: described.role, accessibleName: described.name }
			const derived = deriveCandidates(merged)
			const result = await validateCandidates(frame, derived, uid)
			return buildElementRef({
				...merged,
				candidates: result.accepted.length ? result.accepted : derived.slice(0, 3),
				frame: await buildFramePath(frame),
			})
		}

		/** 元素已消失时，用快照事实重建 ElementRef（候选未经 locator 校验，会带说明） */
		const buildRefFromSnapshotNode = async (
			node: SignatureNode,
			frame: Frame | undefined,
		): Promise<ElementRef | undefined> => {
			if (!node.attributes) return undefined
			const facts = {
				tag: node.tag,
				attributes: node.attributes,
				text: node.text || undefined,
				rect: node.rect,
				scroll: node.scroll ?? { x: 0, y: 0 },
				viewport: node.viewport ?? { width: 0, height: 0 },
				dpr: node.dpr ?? 1,
				recordedAt: Date.now(),
				nodePath: node.nodePath,
				role: node.role,
			}
			const derived = deriveCandidates(facts)
			const ref = buildElementRef({
				...facts,
				candidates: derived.slice(0, 3),
				frame: frame ? await buildFramePath(frame) : undefined,
			})
			ref.description = `${ref.description ?? ''}（元素在处理前已消失，候选未经实时校验）`.trim()
			return ref
		}

		/* ---------- 签名采样器 ----------
		 * 为什么需要它：drive 模式下一批动作可能在几十毫秒内全做完，等我们去 flush 时
		 * 页面早就到最终状态了。如果那时才抓 before/after，所有动作都会看到同一个「后」，
		 * expect 会被归因到错误的那一步（回放时必然误报）。
		 * 采样器按 120ms 打点，处理动作时按时间戳取「动作前最后一个点 / 动作后第一个点」。
		 */
		let sampling = false
		const sampleTimer = setInterval(() => {
			if (sampling) return
			sampling = true
			void (async () => {
				try {
					syncFrames()
					for (const target of additionalPages) {
						if (target.isClosed()) continue
						const pageIndex = ensurePageIndex(target)
						if (!wiredPages.has(target)) {
							await installCaptureOnPage(target, onEmit).catch(() => {})
							attachPageListeners(target)
							// 后附着页面也要记录地址栏导航；startup 之外的页面不能漏掉 baseline。
							primeNavigation(target)
							for (const frame of target.frames()) {
								ensureFrameIndex(frame)
							}
							// 启动时已经 wired 的 additionalPages 是既有上下文，不应被记成新开页。
							recordOpenedTab(target, pageIndex)
						}
					}
					for (const [pageIndex, target] of pagesByIndex) {
						// 采样成本随标签页数量线性涨，超过 4 个就只采样前 4 个（expect 推断本来就是尽力而为）
						if (pageIndex > 3 || target.isClosed()) continue
						const sig = await snapshotPage(target, ensureFrameIndex)
						samples.push({ ts: Date.now(), pageIndex, sig })
					}
					while (samples.length > MAX_SIGNATURE_SAMPLES) samples.shift()
				} catch {
					/* 页面可能在导航，丢了这次采样 */
				} finally {
					sampling = false
				}
			})()
		}, SIGNATURE_INTERVAL_MS)

		/** 动作发生前最后一帧签名（只看这个标签页自己的采样） */
		const signatureBefore = (pageIndex: number, ts: number): PageSignature | undefined => {
			let best: PageSignature | undefined
			for (const sample of samples) {
				if (sample.pageIndex !== pageIndex) continue
				if (sample.ts <= ts) best = sample.sig
				else break
			}
			return best
		}

		/**
		 * 动作的「之后」= 下一个动作之前的最后一帧（同一标签页）。
		 *
		 * 为什么不用「ts + 固定延迟」：drive 模式下相邻动作只隔几毫秒，固定窗口会把后面的
		 * 变化（比如点提交后才出现的提示）算到前一步上，expect 归因错步、回放必然误报。
		 */
		const signatureAfter = (
			pageIndex: number,
			nextTs: number | undefined,
		): PageSignature | undefined => {
			let best: PageSignature | undefined
			for (const sample of samples) {
				if (sample.pageIndex !== pageIndex) continue
				if (nextTs !== undefined && sample.ts >= nextTs) break
				best = sample.sig
			}
			return best ?? lastSigByPage.get(pageIndex)
		}

		/* ---------- buffer 冲洗 ---------- */

		let flushChain: Promise<void> = Promise.resolve()
		let hostEventCursor = 0
		const flush = (force: boolean): Promise<void> => {
			// 定时器与 Stop 可能同时触发冲洗。所有批次都接入同一条 Promise 链，
			// 确保同一时刻只有一个消费者从 pending 拆批；最终强制冲洗会排在旧批次之后，
			// 并等待它们处理完毕后再清理标记和写盘。
			flushChain = flushChain.then(async () => {
				const hostEvents = opts.hostEvents ?? []
				if (!pending.length && hostEventCursor >= hostEvents.length) return
				if (!force && Date.now() - lastEventTs < bufferMs) return
				// splice 在处理前同步取走本批，使随后到达的事件留待下一轮，不与当前批混淆。
				const batch = pending.splice(0, pending.length)
				const hostBatch = hostEvents.slice(hostEventCursor)
				hostEventCursor += hostBatch.length
				try {
					await processBatch(batch, hostBatch)
				} catch (err) {
					warnings.push(`批次处理失败（${batch.length} 个事件）：${(err as Error).message}`)
				}
			})
			return flushChain
		}

		/** 跨批次状态：待定的 hover */
		const pendingHovers: CoalescedAction[] = []

		const nextTsOf = (items: PlannedItem[], index: number): number | undefined => {
			const next = items[index + 1]
			if (!next) return undefined
			return next.kind === 'action' ? next.action.ts : next.ts
		}

		const processBatch = async (
			batch: RawEvent[],
			hostBatch: NonNullable<RecordOptions['hostEvents']>[number][],
		): Promise<void> => {
			const explicitNavigations = hostBatch.filter(
				(event) => event.action === 'userNavigateRequested' && event.url,
			)
			const autoNavigations: RawEvent[] = []
			const pageEvents = batch.filter((event) => {
				if (event.kind === 'navigation' && AUTO_NAVIGATION_TYPES.has(event.navigationType ?? '')) {
					// 机器发起的认证跳转：必须挡在合流器之外（否则并进前一步的 expectUrl，
					// 改写每个点击的预期），转而合成为 isOptional 的独立 navigate 步骤，
					// 由回放时观察浏览器实际行为来决定执行还是跳过。
					autoNavigations.push(event)
					return false
				}
				if (event.kind !== 'navigation') return true
				return !explicitNavigations.some((request) => {
					const pageIndex = opts.tabIds?.indexOf(request.tabId) ?? -1
					return (
						pageIndex === event.pageIndex &&
						Math.abs(event.ts - request.ts) <= 30_000 &&
						request.url === event.url
					)
				})
			})
			const actions = coalesceEvents(pageEvents, { bufferMs })
			const explicitNavigationActions: CoalescedAction[] = explicitNavigations.flatMap((event) => {
				const pageIndex = opts.tabIds?.indexOf(event.tabId) ?? -1
				if (pageIndex < 0 || !event.url) return []
				const raw: RawEvent = {
					kind: 'navigation',
					ts: event.ts,
					pageIndex,
					tabId: event.tabId,
					url: event.url,
					previousUrl: event.previousUrl,
					directNavigation: true,
					navigationType: 'user_navigate',
					navigationEvidence: ['explicit-browser-address-bar-request'],
				}
				return [{
					kind: 'navigate',
					ts: event.ts,
					pageIndex,
					url: event.url,
					previousUrl: event.previousUrl,
					navigationType: 'user_navigate',
					navigationEvidence: raw.navigationEvidence,
					merged: 1,
					raw: [raw],
				}]
			})
			const uniqueActions = actions.filter((action) => {
				if (action.kind !== 'navigate') return true
				return !explicitNavigations.some((event) => {
					const pageIndex = opts.tabIds?.indexOf(event.tabId) ?? -1
					return (
						pageIndex === action.pageIndex &&
						Math.abs(action.ts - event.ts) <= 30_000 &&
						event.url === action.url
					)
				})
			})
			const optionalNavigationActions = synthesizeOptionalNavigations(autoNavigations)
			const orderedActions = [...uniqueActions, ...explicitNavigationActions, ...optionalNavigationActions].sort(
				(a, b) => a.ts - b.ts,
			)

			/* ---- 1. hover 意义过滤（要跨批次：hover 的「后续 click」可能落在下一批） ---- */
			const nonHover: CoalescedAction[] = []
			const batchHovers: CoalescedAction[] = []
			for (const action of orderedActions) {
				if (action.kind === 'hover') batchHovers.push(action)
				else nonHover.push(action)
			}
			const hoverCandidates = [...pendingHovers, ...batchHovers].sort((a, b) => a.ts - b.ts)
			// 先清空旧暂存，再按本轮结果重建；未成熟的 hover 只跨批次保留一次。
			pendingHovers.length = 0
			const keptHovers: CoalescedAction[] = []
			for (const hover of hoverCandidates) {
				if (isMeaningfulHover(hover, nonHover)) {
					keptHovers.push(hover)
					continue
				}
				// 还没等到「悬停后点别的元素」就继续挂着；超时才判定为无声噪声丢弃
				if (Date.now() - hover.ts <= HOVER_WAIT_MS) pendingHovers.push(hover)
			}

			/* ---- 2. 纯函数规划：标签页切换 + 对话框插入 ---- */
			const merged = [...keptHovers, ...nonHover].sort((a, b) => a.ts - b.ts)
			const unconsumedDialogs = dialogs.filter((dialog) => !consumedDialogs.has(dialog))
			const hostTabEvents = hostBatch.flatMap((event) => {
				if (event.action !== 'tabCreated' && event.action !== 'tabActivated') return []
				const index = opts.tabIds?.indexOf(event.tabId) ?? -1
				if (index < 0) return []
				return [{ action: event.action, ts: event.ts, index, url: event.url }]
			})
			const planned = insertDialogs(
				withTabSwitches(merged, tabState, hostTabEvents),
				unconsumedDialogs,
			)
			for (const dialog of planned.consumed) consumedDialogs.add(dialog)
			const items = planned.items

			/* ---- 3. 成步 ---- */
			for (let index = 0; index < items.length; index++) {
				const item = items[index]!
				const id = `s${++stepSeq}`

				if (item.kind === 'switchTab') {
					// 合成步骤：用户点的是浏览器标签栏，页面事件流里没有这条
					pushStep({ kind: 'switchTab', id, index: item.index }, item.pageIndex)
					continue
				}
				if (item.kind === 'openTab') {
					if (!openedTabIndexes.has(item.index)) {
						openedTabIndexes.add(item.index)
						pushStep(
							{
								kind: 'openTab',
								id,
								...(item.url && item.url !== 'about:blank' ? { url: item.url } : {}),
							},
							item.index,
						)
					}
					tabState.page = item.index
					continue
				}
				if (item.kind === 'dialog') {
					pushStep(
						{
							kind: 'dialog',
							id,
							action: item.action,
							...(item.promptText === undefined ? {} : { promptText: item.promptText }),
						},
						item.pageIndex,
					)
					continue
				}

				const action = item.action
				if (action.kind === 'unknown') continue
				const pageIndex = pageIndexOf(action, tabState.page)
				const actionPage = pageOfAction(action)

				// 动作后稳定点：布局不再跳 + 事件流静默（只影响「什么时候算录完」，不影响归因）
				await settleFrameStability(actionPage).catch(() => {})
				await waitForSilence(() => lastEventTs, silenceMs)
				syncFrames()

				const step = await buildStep(action)
				if (!step) continue

				// expect：只在同一标签页内比较签名（跨页比较会误判成 urlChange）
				//
				// hover 要往前多看 600ms：hover 事件是在「停留满 350ms」之后才上报的，
				// 而菜单是 mouseenter 瞬间就展开的 —— 只看 hover.ts 之后会得到「什么都没发生」，
				// 悬停展开的菜单就不会被记成 elementVisible，回放时下一步点菜单项必然 HIDDEN。
				const lookbackMs = action.kind === 'hover' ? HOVER_LOOKBACK_MS : 0
				const before =
					signatureBefore(pageIndex, action.ts - lookbackMs) ?? lastSigByPage.get(pageIndex)
				const after = signatureAfter(pageIndex, nextTsOf(items, index))
				// Preserve FlowForge-style before/after evidence on the original source events.
				// These are structured DOM signatures (not lossy HTML dumps), and remain linked
				// to the executable Flow step through the event's timestamp/page/target facts.
				for (const rawEvent of action.raw) {
					if (before) rawEvent.beforeSnapshot = before
					if (after) rawEvent.afterSnapshot = after
				}
				// v1 的 drag / 可选导航不推断 expect：机器跳转的后果（连锁重定向、DOM 重排）
				// 极易被误判成 elementVisible/urlChange，回放容忍度由 isOptional 机制承担。
				const noInferredExpect = action.kind === 'drag' ||
					(action.kind === 'navigate' && AUTO_NAVIGATION_TYPES.has(action.navigationType ?? ''))
				if (before && after && !noInferredExpect) {
					const inferred = await takeExpect(before, after)
					if (inferred) step.expect = inferred
				}
				if (!step.expect && !noInferredExpect && action.expectUrl)
					step.expect = { kind: 'urlChange', pattern: urlPattern(action.expectUrl) }

				// 下载是「明确的副作用」，优先级高于推断出来的 expect
				const download = findDownloadFor(
					action,
					downloads,
					consumedDownloads,
					nextTsOf(items, index),
				)
				if (download) {
					consumedDownloads.add(download)
					step.expect = { kind: 'download', filenamePattern: downloadFilenamePattern(download.filename) }
				}

				if (after) lastSigByPage.set(pageIndex, after)
				for (const rawEvent of action.raw) {
					rawEvent.flowStepId = step.id
					if ('target' in step && step.target) rawEvent.locatorEvidence = step.target.candidates
				}
				pushStep(step, pageIndex, action.raw)
			}
		}

		/* ---------- 开始录制 ---------- */

		let resolveStop: (() => void) | undefined
		const stopPromise = new Promise<void>((done) => {
			resolveStop = done
		})
		let stopped = false
		const stop = () => {
			if (stopped) return
			stopped = true
			// 幂等关闭入口：Stop IPC、AbortSignal 与 drive 收尾可能几乎同时到达。
			resolveStop?.()
		}
		const onAbort = () => stop()
		opts.stopSignal?.addEventListener('abort', onAbort, { once: true })
		// IPC stop 可以早于录制初始化完成；已经 abort 的信号不会再发一次事件。
		if (opts.stopSignal?.aborted) stop()
		let onSigint: (() => void) | undefined
		let savedSigintListeners: NodeJS.SignalsListener[] = []
		if (!opts.drive) {
			// 人工录制：Ctrl+C 收尾（drive 模式下不接管信号，避免和测试进程抢）
			//
			// 注意：Playwright 自己的 SIGINT handler 会直接 `process.exit(130)`，
			// 抢在我们的收尾（落盘）之前。所以录制期间临时接管 SIGINT，
			// 结束时把原来的监听器原样装回去，不影响宿主程序后续行为。
			savedSigintListeners = process.listeners('SIGINT')
			process.removeAllListeners('SIGINT')
			onSigint = () => stop()
			process.on('SIGINT', onSigint)
		}

		const ticker = setInterval(() => {
			// 定时冲洗只消费已静默满 bufferMs 的批次；Promise 链会与 Stop 的强制冲洗串行。
			void flush(false)
		}, TICK_MS)

		let driveError: Error | undefined
		try {
			if (opts.drive) {
				try {
					await opts.drive(page, stop)
				} catch (err) {
					// drive 抛错必须也走收尾流程，否则 stopPromise 永远不 resolve（录制挂死）
					driveError = err as Error
					warnings.push(`drive 失败：${(err as Error).message}`)
				}
				stop()
			}
			await stopPromise
		} finally {
			clearInterval(ticker)
			if (onSigint) {
				process.off('SIGINT', onSigint)
				for (const listener of savedSigintListeners) process.on('SIGINT', listener)
			}
			opts.stopSignal?.removeEventListener('abort', onAbort)
		}

		// 给最后的驱动动作一点时间把事件送到，再强制冲洗；固定顺序避免丢失末尾异步回调。
		await sleep(Math.min(silenceMs, 400))
		await flush(true)
		await flushChain
		recordingActive = false
		// 采样器必须等最后批次处理完才关闭：末动作的「之后」签名依赖它提供的最新一帧。
		clearInterval(sampleTimer)

		// 收尾 flush 之后仍没被消费的旁路事件：
		// - 对话框：补成末尾步骤（否则回放时会卡在一个没人处理的 dialog 上）
		// - 下载：挂到最后一步的 expect（常见于「点导出 → 立刻下载」）
		for (const dialog of dialogs) {
			if (consumedDialogs.has(dialog)) continue
			consumedDialogs.add(dialog)
			pushStep(
				{
					kind: 'dialog',
					id: `s${++stepSeq}`,
					action: dialog.action,
					...(dialog.promptText === undefined ? {} : { promptText: dialog.promptText }),
				},
				dialog.pageIndex,
			)
		}
		const leftoverDownload = downloads.find((download) => !consumedDownloads.has(download))
		if (leftoverDownload && steps.length) {
			consumedDownloads.add(leftoverDownload)
			const last = steps[steps.length - 1]!
			if (!last.expect)
				last.expect = {
					kind: 'download',
					filenamePattern: downloadFilenamePattern(leftoverDownload.filename),
				}
		}
		// pendingHovers 到最后仍没等到 click → 就是鼠标划过的噪声，直接丢弃（不告警）

		// UID 标记只服务于录制期候选校验；先完成全部步骤构建，再逐页统一清理，避免候选校验失去目标。
		for (const target of pagesByIndex.values()) {
			if (target.isClosed()) continue
			await clearUids(target).catch(() => {})
		}

		/* ---------- 步骤后处理 ---------- */
		// 1) 同一目标连续 input 合并成最后一次（人工输入停顿 >500ms 会被拆成多步）
		// 2) 可编辑元素上的 click 紧跟同目标 input/select 时，丢掉 click（input 自带聚焦）
		const refinedSteps = refineSteps(steps)
		steps.length = 0
		// id 连续化：中途可能有步骤被丢弃（去噪/detached），保证 s1..sN 连续好读
		steps.push(...refinedSteps.map((step, index) => ({ ...step, id: `s${index + 1}` }) as Step))

		/* ---------- 保存登录态（浏览器关闭前；drive 抛错也要存） ---------- */

		// 放在「落盘」之前：即使后面 flow 写盘失败，用户的登录态也已经存下来了
		await persistStorageState()

		/* ---------- 落盘 ---------- */

		if (driveError) {
			// 半截录制不落盘：调用方要的是完整可回放的 flow，不是错位的半截
			throw new Error(
				`drive 回调失败，录制中止（已采集 ${steps.length} 步，未写盘）：${driveError.message}`,
			)
		}
		if (!steps.length) {
			// 空录制是正常取消，不得交给 FlowSchema.min(1) 变成一次看似异常的校验失败。
			throw new EmptyRecordingError()
		}

		const flow: Flow = {
			schemaVersion: SCHEMA_VERSION,
			id: flowId,
			title: opts.title ?? titleFromUrl(startUrl),
			version: 1,
			createdAt: new Date().toISOString(),
			meta: {
				env: {
					startUrl,
					viewport: { width: Math.round(viewport.width), height: Math.round(viewport.height) },
					dpr,
				},
				recorder: { name: RECORDER_NAME, version: RECORDER_VERSION },
			},
			variables: [...variables.values()],
			steps,
			selfHealed: [],
		}

		let rawPath: string | undefined
		if (opts.keepRaw) {
			rawPath = join(dirname(opts.outPath), `${basename(opts.outPath, '.json')}.raw.json`)
			await mkdir(dirname(rawPath), { recursive: true })
			await writeFile(
				rawPath,
				`${JSON.stringify(
					{
						startUrl,
						viewport,
						dpr,
						warnings,
						pages: [...pagesByIndex].map(([index, target]) => ({ index, url: target.url() })),
						dialogs,
						downloads,
						events: allEvents.map((event) => {
							if (event.kind !== 'input' && event.kind !== 'change') return event
							const data = { ...(event.data ?? {}) }
							if (data.value !== undefined) { delete data.value; data.masked = true }
							return { ...event, data }
						}),
					},
					null,
					2,
				)}\n`,
				'utf8',
			)
		}

		// 写前 zod + 契约校验（非法 IR 绝不落盘）
		await saveFlow(flow, opts.outPath)
		return { flow, artifactsDir, rawPath }
	} finally {
		// 兜底：任何异常路径（drive 抛错、goto 失败、保存 flow 失败）都尝试保存一次登录态。
		// persistStorageState 幂等，正常路径已经存过就不会重复写。
		await persistStorageState()
		// 附着模式不关浏览器：页面由 Electron / 调用方持有
		if (ownsBrowser && browser) await browser.close().catch(() => {})
	}
}

/** 接到已有 Page 上录制（Electron 内嵌页）。默认 attachOnly + skipNavigate。 */
export type RecordOnPageOptions = Omit<RecordOptions, 'page' | 'attachOnly' | 'headless'> & {
	page: Page
	attachOnly?: boolean
	skipNavigate?: boolean
}

export async function recordOnPage(opts: RecordOnPageOptions): Promise<RecordResult> {
	return record({
		...opts,
		page: opts.page,
		attachOnly: opts.attachOnly ?? true,
		skipNavigate: opts.skipNavigate ?? true,
		headless: true,
	})
}

/* ------------------------------------------------------------------ */
/* 稳定点 / 静默                                                       */
/* ------------------------------------------------------------------ */

/** 连续 N 帧「布局指纹」不变才算稳定（对应架构里的「连续 2 帧无布局变化」） */
async function settleFrameStability(page: Page): Promise<void> {
	await page
		.evaluate(
			(frames) =>
				new Promise<void>((resolve) => {
					const doc = document.documentElement
					const measure = () =>
						`${doc.scrollWidth}x${doc.scrollHeight}x${document.querySelectorAll('*').length}`
					let last = measure()
					let stable = 0
					let guard = 0
					const tick = () => {
						if (++guard > 120) return resolve()
						const current = measure()
						if (current === last) {
							if (++stable >= frames) return resolve()
						} else {
							stable = 0
							last = current
						}
						requestAnimationFrame(tick)
					}
					requestAnimationFrame(tick)
				}),
			STABLE_FRAMES,
		)
		.catch(() => {
			/* 页面在导航：稳定性检查跳过 */
		})
}

/** 事件流静默：距最后一个事件 ≥ silenceMs（有上限，不卡死） */
async function waitForSilence(getLastEventTs: () => number, silenceMs: number): Promise<void> {
	const started = Date.now()
	while (Date.now() - started < MAX_SETTLE_MS) {
		if (Date.now() - getLastEventTs() >= silenceMs) return
		await sleep(40)
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}

/** 坐标保留 2 位小数（CSS px，不乘 dpr） */
function round2(value: number): number {
	return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

function titleFromUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl)
		return url.pathname && url.pathname !== '/' ? url.pathname : url.hostname
	} catch {
		return rawUrl
	}
}
