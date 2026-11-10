/**
 * 多标签页管理（跨系统复制粘贴这类流程的基础）。
 *
 * 语义约定（与 recorder 对齐）：**index 是标签页的创建顺序**，
 * 0 = 录制起点页面，1 = 第一个新开的标签页…… 关闭的标签页仍占着它的 index（不重排），
 * 这样 flow 里的 `page.index` 在任何时候含义都不变。
 *
 * 纯逻辑部分（`resolveStepPageIndex`）单独导出，便于单测；
 * `PageManager` 负责等页面出现、bringToFront、跟踪关闭。
 */
import type { BrowserContext, Page } from 'playwright-core'

import { StepFailure } from './errors.js'

export interface PageSlot {
	page: Page
	index: number
	closed: boolean
}

/** resolveStepPageIndex 只需要这几个字段（结构化类型，方便单测） */
export interface StepPageLike {
	kind: string
	page?: { index: number } | undefined
	index?: number | undefined
}

/**
 * 这一步应该在哪个标签页执行：
 * - `openTab` → 先沿用当前页，由 run.ts 创建并切到新页；
 * - `step.page.index` 显式指定 → 用它；
 * - `switchTab` → 用它自己的 `index`（但 `step.page` 存在时以 `step.page` 为准）；
 * - 其它 → 沿用当前页（不切）。
 */
export function resolveStepPageIndex(step: StepPageLike, currentIndex: number): number {
	// openTab 先创建并切到新页；若预先按 page.index focus，会等待一个尚不存在的页。
	if (step.kind === 'openTab') return currentIndex
	if (step.page && typeof step.page.index === 'number') {
		// 冲突时以 step.page 为准（契约约定）
		if (step.kind === 'switchTab' && step.index !== undefined && step.index !== step.page.index) {
			return step.page.index
		}
		return step.page.index
	}
	if (step.kind === 'switchTab' && typeof step.index === 'number') return step.index
	return currentIndex
}

export type PageWaitMode = 'appear' | 'ready'

export interface PageManagerOptions {
	/**
	 * 只把这些 page 登记为起点（index 按数组顺序）。
	 * Electron CDP 的 default context 里还有产品壳页面，必须用 seed 排除它们。
	 */
	seed?: Page[]
	/** 是否监听 context 新开页；附着模式默认 false */
	watchNewPages?: boolean
	/** 新登记的页（含 seed）；宿主据此同步原生标签页映射 */
	onPage?: (page: Page, index: number) => void
	/** 宿主原生开页工厂；工厂负责可选 URL 导航 */
	openPage?: (url?: string) => Promise<Page>
}

export class PageManager {
	readonly #context: BrowserContext
	readonly #log: (msg: string) => void
	readonly #slots: PageSlot[] = []
	#current = 0
	readonly #onPage: ((page: Page, index: number) => void) | undefined
	readonly #openPage: ((url?: string) => Promise<Page>) | undefined

	constructor(
		context: BrowserContext,
		log: (msg: string) => void = () => {},
		options: PageManagerOptions = {},
	) {
		this.#context = context
		this.#log = log
		this.#onPage = options.onPage
		this.#openPage = options.openPage
		const seed = options.seed
		if (seed && seed.length > 0) {
			for (const page of seed) this.#append(page)
		} else {
			for (const page of context.pages()) this.#append(page)
		}
		if (options.watchNewPages !== false) {
			context.on('page', (page) => {
				const slot = this.#append(page)
				this.#log(`新标签页 ${slot.index} 出现（当前共 ${this.#slots.length} 个）`)
			})
		}
	}

	#append(page: Page): PageSlot {
		// 页面事件和显式 open() 可能报告同一个 Page；保留原槽位，
		// 不为同一页面重复分配索引。
		const existing = this.#slots.find((slot) => slot.page === page)
		if (existing) return existing
		const slot: PageSlot = { page, index: this.#slots.length, closed: false }
		this.#slots.push(slot)
		this.#onPage?.(page, slot.index)
		page.on('close', () => {
			slot.closed = true
			this.#log(`标签页 ${slot.index} 已关闭`)
		})
		return slot
	}

	/** 所有槽位（含已关闭的，index 语义稳定） */
	get slots(): readonly PageSlot[] {
		return this.#slots
	}

	get count(): number {
		return this.#slots.length
	}

	get openCount(): number {
		return this.#slots.filter((slot) => !slot.closed).length
	}

	get currentIndex(): number {
		return this.#current
	}

	/** 当前标签页；当前页被关了就退到第一个还活着的页 */
	current(): Page {
		const slot = this.#slots[this.#current]
		if (slot && !slot.closed) return slot.page
		const fallback = this.#slots.find((candidate) => !candidate.closed)
		if (!fallback) {
			throw new StepFailure('BROWSER_CRASH', '所有标签页都已关闭，无法继续回放')
		}
		this.#log(`当前标签页 ${this.#current} 已关闭，回退到标签页 ${fallback.index}`)
		this.#current = fallback.index
		return fallback.page
	}

	/** 指定 index 的页（不存在/已关闭抛语义错误） */
	pageAt(index: number): Page {
		const slot = this.#slots[index]
		if (!slot) {
			throw new StepFailure(
				'NAVIGATION_FAILED',
				`标签页 index=${index} 不存在（当前已打开 ${this.#slots.length} 个）`,
			)
		}
		if (slot.closed) {
			throw new StepFailure('NAVIGATION_FAILED', `标签页 index=${index} 已被关闭`)
		}
		return slot.page
	}

	/**
	 * 等标签页出现（点击新开窗口时页面是异步出现的），可选等 load 完成。
	 * 超时 → NAVIGATION_FAILED（"目标上下文不可用"与导航失败同域）。
	 */
	async waitForPage(
		index: number,
		timeoutMs: number,
		options: { mode?: PageWaitMode; pollMs?: number } = {},
	): Promise<PageSlot> {
		const mode = options.mode ?? 'appear'
		const pollMs = options.pollMs ?? 50
		const deadline = Date.now() + Math.max(0, timeoutMs)
		for (;;) {
			// 先检查是否已登记；ready 模式额外等待 load，appear 模式只要求页面已创建。
			const slot = this.#slots[index]
			if (slot) {
				if (slot.closed) {
					throw new StepFailure('NAVIGATION_FAILED', `标签页 index=${index} 已被关闭`)
				}
				if (mode === 'ready') {
					const remaining = Math.max(0, deadline - Date.now())
					await slot.page
						.waitForLoadState('load', { timeout: Math.min(remaining, 5_000) })
						.catch(() => {
							/* 页面可能一直有挂起请求，appear 已达成即可 */
						})
				}
				return slot
			}
			if (Date.now() >= deadline) {
				throw new StepFailure(
					'NAVIGATION_FAILED',
					`标签页 index=${index} 在 ${timeoutMs}ms 内没有出现（当前已打开 ${this.#slots.length} 个）`,
				)
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
		}
	}

	/** 切到指定 index：等出现 → bringToFront（键盘输入必需）→ 记为当前页 */
	async focus(index: number, timeoutMs: number): Promise<PageSlot> {
		const slot = await this.waitForPage(index, timeoutMs, { mode: 'ready' })
		try {
			await slot.page.bringToFront()
		} catch {
			/* 后台页/已失焦时可能失败，不影响后续 locator 操作 */
		}
		this.#current = slot.index
		this.#log(`切换到标签页 ${index}（${slot.page.url()}）`)
		return slot
	}

	async open(url?: string): Promise<PageSlot> {
		const page = this.#openPage ? await this.#openPage(url) : await this.#context.newPage()
		const slot = this.#append(page)
		this.#current = slot.index
		// 宿主工厂已经按自己的安全边界完成导航；默认 Playwright 路径才在这里 goto。
		if (url && !this.#openPage) await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
		this.#log(`打开标签页 ${slot.index}${url ? `（${url}）` : ''}`)
		return slot
	}

	async close(index?: number): Promise<void> {
		// 关闭后仍保留槽位，确保后续页面沿用历史索引；
		// 这里只把当前指针移到仍存活的页面。
		const targetIndex = index ?? this.#current
		const slot = this.#slots[targetIndex]
		if (!slot || slot.closed) return
		await slot.page.close().catch(() => {})
		slot.closed = true
		const fallback = this.#slots.find((candidate) => !candidate.closed)
		this.#current = fallback?.index ?? 0
		this.#log(`关闭标签页 ${targetIndex}`)
	}

	/** context.pages() 的实时快照（诊断/断言用） */
	livePages(): Page[] {
		return this.#context.pages()
	}
}
