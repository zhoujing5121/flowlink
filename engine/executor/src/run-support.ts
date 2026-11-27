/**
 * 回放运行的小型支撑原语：安全取 URL、对话框计数比较、页面操作超时兜底、
 * 目标高亮。都是无状态的独立辅助，供 runFlowInBrowserContext 与重跑路径复用。
 */
import type { Locator, Page } from 'playwright-core'

import { sleep } from './verify.js'

/** 取当前 page 的 URL；页面已关闭/崩溃时返回 undefined（用于登录过期提示判断） */
export function safePageUrl(page: Page | undefined): string | undefined {
	if (!page) return undefined
	try {
		return page.url()
	} catch {
		return undefined
	}
}

/** 对话框计数比较：只在"变多"时算历史变化（对话框被处理掉不算新事件）。 */
export function dialogManagerHistoryChanged(before: number, after: number): boolean {
	return after > before
}

/**
 * 给"可能被原生对话框阻塞"的页面操作加超时上限。
 * 页面 JS 被 alert/confirm 阻塞时，`evaluate`/`screenshot` 会一直等到 Playwright 超时，
 * 让整个 run 看起来像卡死；这里用 race 兜住，超时返回 fallback 由调用方决定怎么处理。
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([promise, sleep(ms).then(() => fallback)])
}

/**
 * 给目标元素加一圈临时高亮，让业务人员看得见"现在要操作哪里"。
 * 用 elementHandle.evaluate，iframe 内元素也生效（在所属文档里加 outline）。
 */
export async function flashLocator(locator: Locator, delayMs: number): Promise<void> {
	const handle = await locator.elementHandle({ timeout: 1500 }).catch(() => null)
	if (!handle) {
		await sleep(delayMs)
		return
	}
	/** 单次描边/清除动作；evaluate 失败静默（元素可能已被页面更新移走）。 */
	const paint = (color: string | null) =>
		handle
			.evaluate((el: Element, c: string | null) => {
				const style = (el as HTMLElement).style
				if (c) {
					style.outline = `3px solid ${c}`
					style.outlineOffset = '2px'
				} else {
					style.outline = ''
					style.outlineOffset = ''
				}
			}, color)
			.catch(() => undefined)
	await paint('#ff6b00')
	await sleep(delayMs)
	await paint(null)
	await handle.dispose().catch(() => undefined)
}
