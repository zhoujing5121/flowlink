/**
 * 回放证据采集的页面内探测原语：元素事实提取、页面快照、DOM 变更探针。
 * 只做与具体流程无关的页面观测，供 runFlowInBrowserContext 的自愈写回与
 * NO_EFFECT 判定调用；不持有任何运行状态。
 */
import type { Page } from 'playwright-core'

import type { ElementFacts } from './selfheal.js'

/** 页面内取元素事实（给自愈写回生成候选用） */
export function factsOf(el: Element): ElementFacts {
	const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
	const ariaLabel = el.getAttribute('aria-label') ?? undefined
	return {
		tag: el.tagName.toLowerCase(),
		id: el.getAttribute('id') ?? undefined,
		testid:
			el.getAttribute('data-testid') ??
			el.getAttribute('data-test') ??
			el.getAttribute('data-cy') ??
			undefined,
		role: el.getAttribute('role') ?? undefined,
		accessibleName: ariaLabel ?? (text.length > 0 ? text : undefined),
		nameAttr: el.getAttribute('name') ?? undefined,
		text,
		ariaLabel,
		placeholder: el.getAttribute('placeholder') ?? undefined,
	}
}

/** 页面快速快照（失败 artifact 用；不含大段 HTML，避免 artifact 爆掉） */
export async function captureSnapshot(page: Page): Promise<unknown> {
	const base = await page
		.evaluate(() => ({
			url: location.href,
			title: document.title,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			scroll: { x: window.scrollX, y: window.scrollY },
			activeElement: document.activeElement ? document.activeElement.tagName : null,
			text: (document.body ? document.body.innerText : '').slice(0, 4_000),
		}))
		.catch(() => ({ url: page.url(), title: '', viewport: null, scroll: null, text: '' }))
	let ariaSnapshot = ''
	try {
		ariaSnapshot = (await page.ariaSnapshot({ mode: 'ai' })).slice(0, 20_000)
	} catch {
		/* 页面已崩溃/关闭时忽略 */
	}
	return { ...base, ariaSnapshot }
}

/**
 * 安装 DOM 变更探针（NO_EFFECT 判定用）：重复调用先断开旧探针、计数清零。
 * 计数器挂 window.__rrMut；页面未就绪时静默（探测退化为只看 URL）。
 */
export async function armMutationProbe(page: Page): Promise<void> {
	await page
		.evaluate(() => {
			const w = window as unknown as {
				__rrProbe?: { disconnect: () => void }
				__rrMut?: number
			}
			if (w.__rrProbe) w.__rrProbe.disconnect()
			w.__rrMut = 0
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					// L2 打的临时标记不算"页面有变化"
					if (record.type === 'attributes') {
						const name = record.attributeName ?? ''
						if (name.startsWith('data-rr-')) continue
					}
					w.__rrMut = (w.__rrMut ?? 0) + 1
				}
			})
			observer.observe(document, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true,
			})
			w.__rrProbe = observer
		})
		.catch(() => {
			/* 页面还没 ready 时忽略，NO_EFFECT 探测退化为只看 url */
		})
}

/**
 * 活动元素签名。
 * 用途：点击可聚焦元素会引起 focus ring 重绘（像素变了但产品上"什么都没发生"），
 * 所以 NO_EFFECT 判定要把"焦点变化"单独识别出来，否则所有按钮点击都会被误判成 NO_EFFECT。
 */
export async function activeElementSig(page: Page): Promise<string> {
	return page
		.evaluate(() => {
			const el = document.activeElement
			if (!el) return ''
			const html = el as HTMLElement
			return `${el.tagName}#${html.id ?? ''}`
		})
		.catch(() => '')
}

/** 读探针计数；页面已关闭/崩溃时返回 0（"没有变化"与"读不到"同判，由上游兜底）。 */
export async function readMutationCount(page: Page): Promise<number> {
	return page
		.evaluate(() => {
			const w = window as unknown as { __rrMut?: number }
			return w.__rrMut ?? 0
		})
		.catch(() => 0)
}
