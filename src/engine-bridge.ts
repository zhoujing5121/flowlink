/**
 * 引擎桥接：把 @rr/* 的录放能力接到 Electron 内嵌浏览器（WebContentsView）上。
 *
 * Electron 以 --remote-debugging-port=0 启动，端口写在 userData/DevToolsActivePort。
 * Playwright 通过 connectOverCDP 附着整个 Electron，再用「页面标记」把
 * 某个 WebContentsView 的 webContents 映射成 Playwright Page：
 * 先在页面里写 window 标记，再遍历 CDP 页面找同一个标记。
 * （URL 匹配在多个标签页打开同一站点时会撞车，标记不会。）
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { WebContents } from 'electron'
import { chromium, type Browser, type Page } from 'playwright-core'

export class EngineBridge {
	private browser: Browser | null = null
	private readonly pages = new Map<string, Page>()

	constructor(private readonly userDataDir: string) {}

	/** 读取 Electron 实际监听的 CDP 端口（remote-debugging-port=0 表示随机） */
	private async cdpPort(): Promise<number> {
		const raw = await readFile(join(this.userDataDir, 'DevToolsActivePort'), 'utf8')
		const port = Number(raw.split('\n')[0]?.trim())
		if (!Number.isInteger(port) || port <= 0) {
			throw new Error('无法读取 Electron 的 CDP 端口（DevToolsActivePort 缺失或非法）')
		}
		return port
	}

	private async ensureBrowser(): Promise<Browser> {
		if (this.browser?.isConnected()) return this.browser
		const port = await this.cdpPort()
		this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
		return this.browser
	}

	/** 把某个标签页的 webContents 映射成 Playwright Page（按标记匹配，缓存复用） */
	async pageFor(tabId: string, webContents: WebContents): Promise<Page> {
		const cached = this.pages.get(tabId)
		if (cached && !cached.isClosed()) return cached

		const marker = `__flowlinkTab_${tabId.replace(/[^\w-]/g, '')}`
		await webContents
			.executeJavaScript(`window[${JSON.stringify(marker)}] = true; true`)
			.catch(() => {})

		const browser = await this.ensureBrowser()
		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				const hit = await page
					.evaluate((name) => Boolean((window as Record<string, unknown>)[name]), marker)
					.catch(() => false)
				if (hit) {
					this.pages.set(tabId, page)
					return page
				}
			}
		}
		throw new Error('未能附着到内嵌浏览器页面（CDP 页面列表里找不到对应标签页）')
	}

	/** 标签页被销毁后清理缓存的 Page 句柄 */
	forget(tabId: string): void {
		this.pages.delete(tabId)
	}
}
