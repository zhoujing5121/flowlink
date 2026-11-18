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
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CDPSession, Page } from 'playwright-core'

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
	tabs: Array<{ tabId: string; label: string; file: string; events: number }>
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
	/** 写流失败后置位；收尾时该 tab 停止接收事件 */
	writeFailed: boolean
	page: Page
	cdp: CDPSession | null
	initScriptIdentifier: string | null
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

async function writeManifest(endedAt: number | null): Promise<void> {
	if (!activeDir) return
	const manifest: RrwebManifest = {
		version: 1,
		startedAt,
		endedAt,
		tabs: tabs.map(({ tabId, label, file, events }) => ({ tabId, label, file, events })),
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
	for (const entry of seed.pages) {
		await attachRrwebPage(entry, source).catch((err) => {
			console.warn(`[flowlink] rrweb 标签页 ${entry.tabId} 挂接失败：`, (err as Error).message)
		})
	}
	await writeManifest(null).catch(() => undefined)
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
		writeFailed: false,
		page,
		cdp: null,
		initScriptIdentifier: null,
	}
	stream.on('error', () => {
		tab.writeFailed = true
		console.warn(`[flowlink] rrweb 事件文件写入失败：${file}`)
	})
	tabs.push(tab)
	sinks.set(entry.tabId, (event) => {
		if (tab.writeFailed || !event || typeof event !== 'object') return
		tab.events++
		tab.stream.write(`${JSON.stringify({ ts: Date.now(), event })}\n`)
	})

	// init script 覆盖后续导航；用原生 CDP 注册是为了停止时能显式移除
	//（Playwright 的 addInitScript 没有移除接口，残留会让停止后的导航继续空录）。
	const cdp = await page.context().newCDPSession(page).catch(() => null)
	tab.cdp = cdp
	if (cdp) {
		const added = await cdp
			.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript(script, entry.tabId) })
			.catch(() => null)
		tab.initScriptIdentifier = added?.identifier ?? null
	}

	// 当前文档立即生效：导航竞态（context destroyed）时有限重试，
	// 仍失败则交给 init script 在下一次导航时兜底。
	for (let attempt = 0; attempt < 5; attempt++) {
		const booted = await page
			.evaluate(
				`(function(){${bootScript(script, entry.tabId)};return typeof window.__flowlinkRrwebStop === 'function'})()`,
			)
			.catch(() => false)
		if (booted === true) break
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
}

/** 记录标签页激活时间线（browser:switchTab 时由 main.ts 推送）。 */
export function recordRrwebActivation(tabId: string): void {
	if (!activeDir || typeof tabId !== 'string') return
	if (!tabs.some((tab) => tab.tabId === tabId)) return
	activations.push({ ts: Date.now(), tabId })
	// 激活很少发生，顺手落盘让崩溃后也能恢复大部分时间线。
	void writeManifest(null).catch(() => undefined)
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
	const manifest: RrwebManifest = {
		version: 1,
		startedAt: sessionStartedAt,
		endedAt: Date.now(),
		tabs: sessionTabs.map(({ tabId, label, file, events }) => ({ tabId, label, file, events })),
		activations: sessionActivations,
	}
	await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8').catch(
		() => undefined,
	)
	return { dir, tabCount: sessionTabs.length, eventCount }
}
