/**
 * rrweb 录制会话：把内嵌浏览器各标签页的 DOM 事件流式落盘（真·录屏）。
 *
 * 与旧「800ms capturePage 截屏拼 webm」管线的区别：录制器跑在页面里
 * （MutationObserver / 事件监听，由 dist/rrweb-inject.js 提供），主进程只把
 * 到达的事件逐行 append 到 `<root>/record/rrweb/<tabId>.jsonl`——没有像素
 * 编码、没有周期性大体积 IPC，内存里只保留计数，占用有界。
 *
 * 每个标签页的注入顺序（顺序有含义）：
 *  1. exposeBinding('__flowlinkRrwebEvent')：页面 → Node 的事件通道，先注册，
 *     新文档里函数先于注入脚本可用；tabId 由页面随事件携带；
 *  2. CDP Page.addScriptToEvaluateOnNewDocument：之后每次导航自动 boot，
 *     停止时显式移除，避免停止后的导航继续空录；
 *  3. page.evaluate：当前已加载文档立即 boot（带重试，覆盖导航竞态）。
 *
 * 导航看门狗（主框架 framenavigated）：上述任一环节在新文档丢失都会让事件流
 * 静默断流，因此每次主框架导航后统一重 evaluate boot + 校验/重建 CDP 注册，
 * 事件到达率不依赖任何单点（见 attachRrwebPage 尾部的监听注册）。
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CDPSession, Frame, Page } from 'playwright-core'

/** 注入产物路径（dist/rrweb-inject.js，与 dist/main.js 一起分发）。 */
const INJECT_JS_PATH = fileURLToPath(new URL('./rrweb-inject.js', import.meta.url))

/** 页面 → Node 的事件绑定名（与 src/rrweb-inject.ts 约定一致）。 */
const EVENT_BINDING = '__flowlinkRrwebEvent'

export interface RrwebPageSeed {
	page: Page
	tabId: string
	label: string
}

export interface RrwebRecordingSummary {
	dir: string
	tabCount: number
	eventCount: number
}

export interface RrwebManifest {
	version: 1
	startedAt: number
	endedAt: number | null
	tabs: Array<{
		tabId: string
		label: string
		file: string
		events: number
		/** 该 tab 最后一个事件到达的主进程时间（健康度：诊断事件流何时断流） */
		lastEventAt: number | null
	}>
	activations: Array<{ ts: number; tabId: string }>
}

interface RrwebTabSession {
	tabId: string
	label: string
	/** manifest 里记录的文件名（<sanitized>.jsonl） */
	file: string
	stream: WriteStream
	/** 事件计数（事件本体不驻留内存） */
	events: number
	/** 最后一个事件到达时间（manifest 健康度） */
	lastEventAt: number | null
	/** 写流失败后置位；收尾时该 tab 停止接收事件 */
	writeFailed: boolean
	page: Page
	cdp: CDPSession | null
	initScriptIdentifier: string | null
	/** 主框架导航看门狗（导航后重 boot + 修 CDP 注册；停止时解绑） */
	onFrameNavigated: ((frame: Frame) => void) | null
	/** 导航重 boot 的去抖定时器（重定向链只处理最后落点） */
	navRebootTimer: ReturnType<typeof setTimeout> | null
}

let injectSourcePromise: Promise<string> | undefined
function injectSource(): Promise<string> {
	injectSourcePromise ??= readFile(INJECT_JS_PATH, 'utf8')
	return injectSourcePromise
}

/* 会话状态（同一时刻至多一个录制会话） */
let activeDir = ''
let startedAt = 0
let tabs: RrwebTabSession[] = []
let activations: Array<{ ts: number; tabId: string }> = []
/** tabId → 事件 sink；停止时整体替换为空 Map 立即断流。 */
let sinks = new Map<string, (event: unknown) => void>()
/** 已 exposeBinding 的 Page 对象（Playwright 同名重复注册会抛错）。 */
const bindingPages = new WeakSet<object>()

function bootScript(source: string, tabId: string): string {
	return `${source};window.__flowlinkRrwebBoot&&window.__flowlinkRrwebBoot(${JSON.stringify(tabId)});`
}

async function ensureEventBinding(page: Page): Promise<void> {
	if (bindingPages.has(page)) return
	try {
		await page.exposeBinding(EVENT_BINDING, (_source, tabId: unknown, event: unknown) => {
			// tabId 由注入脚本随事件携带，跨会话/跨 CDP 连接重注册时也能正确路由。
			if (typeof tabId !== 'string') return
			sinks.get(tabId)?.(event)
		})
	} catch (err) {
		// CDP 重连后新旧 Page 包装并存时可能撞「已注册」：旧绑定同样按 tabId
		// 路由到当前 sink，可以安全忽略；其余错误照常抛出。
		if (!/already\s+registered|has\s+been\s+already/i.test(String((err as Error).message))) {
			throw err
		}
	}
	bindingPages.add(page)
}

/** manifest 健康度（每 tab 最后事件时间）的落盘节流：应用崩溃后也能看到断流时点。 */
const MANIFEST_HEALTH_WRITE_MS = 5_000
let lastHealthWriteAt = 0

/** 串行化 manifest 写入（tmp+rename 原子写不能并发；链上失败不中断后续）。 */
let manifestWriteChain: Promise<void> = Promise.resolve()
function scheduleManifestWrite(endedAt: number | null): Promise<void> {
	manifestWriteChain = manifestWriteChain
		.then(() => writeManifest(endedAt))
		.catch(() => undefined)
	return manifestWriteChain
}

async function writeManifest(endedAt: number | null): Promise<void> {
	if (!activeDir) return
	const manifest: RrwebManifest = {
		version: 1,
		startedAt,
		endedAt,
		tabs: tabs.map(({ tabId, label, file, events, lastEventAt }) => ({
			tabId,
			label,
			file,
			events,
			lastEventAt,
		})),
		activations,
	}
	const target = join(activeDir, 'manifest.json')
	const tmp = `${target}.tmp`
	await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
	await rename(tmp, target)
}

/** 启动 rrweb 会话：先防御性收尾上一会话，再为每个种子标签页建立注入与事件流。 */
export async function startRrwebRecording(seed: {
	rootDir: string
	pages: RrwebPageSeed[]
	activeTabId: string
}): Promise<void> {
	await stopRrwebRecording().catch(() => undefined)
	let source: string
	try {
		source = await injectSource()
	} catch (err) {
		// 注入产物缺失（未构建/打包遗漏）不应中断步骤录制：降级为无录屏，
		// Stop 时返回空摘要，Record 标签页回退到截图墙。
		console.error('[flowlink] rrweb 注入脚本读取失败（dist/rrweb-inject.js 缺失？），本段录制无录屏：', (err as Error).message)
		return
	}
	activeDir = join(seed.rootDir, 'record', 'rrweb')
	await mkdir(activeDir, { recursive: true })
	startedAt = Date.now()
	tabs = []
	activations = [{ ts: startedAt, tabId: seed.activeTabId }]
	sinks = new Map()
	lastHealthWriteAt = 0
	for (const entry of seed.pages) {
		await attachRrwebPage(entry, source).catch((err) => {
			console.warn(`[flowlink] rrweb 标签页 ${entry.tabId} 挂接失败：`, (err as Error).message)
		})
	}
	await scheduleManifestWrite(null)
}

/**
 * 补挂一个标签页（录制中途新开标签页时由 main.ts 调用）。
 * 无活动会话时是 no-op；source 可传入已读取的注入脚本避免重复读盘。
 */
export async function attachRrwebPage(entry: RrwebPageSeed, source?: string): Promise<void> {
	if (!activeDir) return
	if (tabs.some((tab) => tab.tabId === entry.tabId)) return
	const script = source ?? (await injectSource())
	const page = entry.page
	await ensureEventBinding(page)

	const file = `${entry.tabId.replace(/[^\w.-]/g, '_') || 'tab'}.jsonl`
	const stream = createWriteStream(join(activeDir, file), { flags: 'a', encoding: 'utf8' })
	const tab: RrwebTabSession = {
		tabId: entry.tabId,
		label: entry.label,
		file,
		stream,
		events: 0,
		lastEventAt: null,
		writeFailed: false,
		page,
		cdp: null,
		initScriptIdentifier: null,
		onFrameNavigated: null,
		navRebootTimer: null,
	}
	stream.on('error', () => {
		tab.writeFailed = true
		console.warn(`[flowlink] rrweb 事件文件写入失败：${file}`)
	})
	tabs.push(tab)
	sinks.set(entry.tabId, (event) => {
		if (tab.writeFailed || !event || typeof event !== 'object') return
		const now = Date.now()
		tab.events++
		tab.lastEventAt = now
		// 健康度节流落盘（≤ 每 5s 一次）：崩溃后 manifest 也能反映断流时点。
		if (now - lastHealthWriteAt >= MANIFEST_HEALTH_WRITE_MS) {
			lastHealthWriteAt = now
			void scheduleManifestWrite(null)
		}
		tab.stream.write(`${JSON.stringify({ ts: now, event })}\n`)
	})

	// init script 覆盖后续导航；用原生 CDP 注册是为了停止时能显式移除
	//（Playwright 的 addInitScript 没有移除接口，残留会让停止后的导航继续空录）。
	await ensureCdpInitScript(tab, script)

	// 当前文档立即生效：导航竞态（context destroyed）时有限重试，
	// 仍失败则交给 init script 与页内 binding 自旋兜底。
	await bootCurrentDocument(tab, script)

	// 导航看门狗（Bug 4）：主框架跨文档导航后，init script 或 Playwright 绑定
	// 注入任一丢失都会让事件流静默断流（证据 recording-1794978215241：事件止于
	// 5150ms）。导航后统一重 evaluate boot（幂等），并校验 CDP session 上的
	// init script 注册仍存活（失联则重建 session + 重新注册）。事件到达率
	// 不再依赖任何单点。停止时解绑。
	tab.onFrameNavigated = (frame) => {
		if (frame !== page.mainFrame()) return
		// 重定向链会连发多次 framenavigated：去抖 300ms 只处理最后落点，
		// 同时给新文档一点起跑时间，避开 execution context 销毁风暴。
		if (tab.navRebootTimer) clearTimeout(tab.navRebootTimer)
		tab.navRebootTimer = setTimeout(() => {
			tab.navRebootTimer = null
			if (!tabSessionLive(tab)) return
			void rebootTabAfterNavigation(tab).catch(() => undefined)
		}, 300)
	}
	page.on('framenavigated', tab.onFrameNavigated)
}

/** 该 tab 是否仍属于当前活动会话（停止时 tabs 被同步清空；防在途看门狗任务泄漏）。 */
function tabSessionLive(tab: RrwebTabSession): boolean {
	return tabs.includes(tab)
}

/** 当前文档立即 evaluate boot（幂等）。返回是否确认已在录（页内仍有自旋兜底）。 */
async function bootCurrentDocument(tab: RrwebTabSession, source: string): Promise<boolean> {
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!tabSessionLive(tab)) return false
		const booted = await tab.page
			.evaluate(
				`(function(){${bootScript(source, tab.tabId)};return typeof window.__flowlinkRrwebStop === 'function'})()`,
			)
			.catch(() => false)
		if (booted === true) return true
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return false
}

/**
 * 确保 tab 的 CDP session 存活且 init script 已注册：跨进程导航/目标更换会使
 * session 失联（addScriptToEvaluateOnNewDocument 注册随之丢失，后续导航不再
 * 自动 boot）。探测失败即重建 session 并重新注册；session 健康时是 no-op。
 * 每个副作用前都校验会话仍存活——停止与在途重建赛跑时不留泄漏。
 */
async function ensureCdpInitScript(tab: RrwebTabSession, source: string): Promise<void> {
	let alive = false
	if (tab.cdp) {
		alive = await tab.cdp
			.send('Runtime.evaluate', { expression: '1' })
			.then(() => true)
			.catch(() => false)
	}
	if (alive) return
	if (!tabSessionLive(tab)) return
	await tab.cdp?.detach().catch(() => undefined)
	const cdp = await tab.page.context().newCDPSession(tab.page).catch(() => null)
	if (!cdp || !tabSessionLive(tab)) {
		// 会话在等待期间停止：拆掉刚建的 session，不落任何注册。
		await cdp?.detach().catch(() => undefined)
		if (tab.cdp === cdp) tab.cdp = null
		return
	}
	tab.cdp = cdp
	tab.initScriptIdentifier = null
	const added = await cdp
		.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript(source, tab.tabId) })
		.catch(() => null)
	if (!tabSessionLive(tab)) {
		if (added?.identifier) {
			await cdp
				.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.identifier })
				.catch(() => undefined)
		}
		await cdp.detach().catch(() => undefined)
		if (tab.cdp === cdp) tab.cdp = null
		return
	}
	tab.initScriptIdentifier = added?.identifier ?? null
}

/** 导航后的自愈（看门狗调用）：修 CDP 注册 + 当前文档重 boot。 */
async function rebootTabAfterNavigation(tab: RrwebTabSession): Promise<void> {
	if (!tabSessionLive(tab)) return
	const source = await injectSource()
	await ensureCdpInitScript(tab, source)
	const booted = await bootCurrentDocument(tab, source)
	if (!booted && tabSessionLive(tab)) {
		console.warn(
			`[flowlink] rrweb 标签页 ${tab.tabId} 导航后未能确认重启录制（页面不可用？），事件可能缺失`,
		)
	}
}

/** 记录标签页激活时间线（browser:switchTab 时由 main.ts 推送）。 */
export function recordRrwebActivation(tabId: string): void {
	if (!activeDir || typeof tabId !== 'string') return
	if (!tabs.some((tab) => tab.tabId === tabId)) return
	activations.push({ ts: Date.now(), tabId })
	// 激活很少发生，顺手落盘让崩溃后也能恢复大部分时间线。
	void scheduleManifestWrite(null)
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout>
	const deadline = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs)
	})
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * 停止会话：页面侧停录 + 移除 init script + detach（全部尽力而为、限时），
 * 然后收尾事件流并写终版 manifest。返回目录与统计；无活动会话时返回空摘要。
 */
export async function stopRrwebRecording(): Promise<RrwebRecordingSummary> {
	const dir = activeDir
	if (!dir) return { dir: '', tabCount: 0, eventCount: 0 }
	const sessionTabs = tabs
	const sessionStartedAt = startedAt
	const sessionActivations = activations
	// 立即断流并摘下会话状态：迟到事件不再写盘，也不再挂接新标签页；
	// 终版 manifest 用这里的快照直接写。
	sinks = new Map()
	tabs = []
	activations = []
	activeDir = ''
	startedAt = 0

	await Promise.all(
		sessionTabs.map(async (tab) => {
			// 先摘掉导航看门狗：停止后不再重 boot、不再重建 CDP session。
			if (tab.navRebootTimer) {
				clearTimeout(tab.navRebootTimer)
				tab.navRebootTimer = null
			}
			if (tab.onFrameNavigated) {
				tab.page.off('framenavigated', tab.onFrameNavigated)
				tab.onFrameNavigated = null
			}
			await withDeadline(
				tab.page
					.evaluate('(window.__flowlinkRrwebStop||function(){})()')
					.catch(() => undefined),
				2000,
			)
			if (tab.initScriptIdentifier && tab.cdp) {
				await tab.cdp
					.send('Page.removeScriptToEvaluateOnNewDocument', {
						identifier: tab.initScriptIdentifier,
					})
					.catch(() => undefined)
			}
			if (tab.cdp) await tab.cdp.detach().catch(() => undefined)
		}),
	)

	await Promise.all(
		sessionTabs.map(
			(tab) =>
				new Promise<void>((resolve) => {
					let settled = false
					const done = (): void => {
						if (!settled) {
							settled = true
							resolve()
						}
					}
					tab.stream.once('close', done)
					try {
						tab.stream.end()
					} catch {
						done()
					}
					// 极端情况下写流卡住也不让 Stop 永等。
					setTimeout(done, 3000).unref()
				}),
		),
	)

	const eventCount = sessionTabs.reduce((sum, tab) => sum + tab.events, 0)
	// 终版 manifest 必须最后落盘：activeDir 已清空，链上残余（健康度/激活）
	// 调用此刻已是 no-op，但仍先排空写入链，避免终版被旧数据覆盖。
	await manifestWriteChain
	const manifest: RrwebManifest = {
		version: 1,
		startedAt: sessionStartedAt,
		endedAt: Date.now(),
		tabs: sessionTabs.map(({ tabId, label, file, events, lastEventAt }) => ({
			tabId,
			label,
			file,
			events,
			lastEventAt,
		})),
		activations: sessionActivations,
	}
	await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8').catch(
		() => undefined,
	)
	return { dir, tabCount: sessionTabs.length, eventCount }
}
