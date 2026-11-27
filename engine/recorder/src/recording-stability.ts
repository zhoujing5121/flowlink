/**
 * 录制期的稳定点/静默等待原语：布局帧稳定判定、事件流静默、微sleep与数值钳制。
 * record() 的沉降流程与事件合流都建立在这些原语上；不持有任何录制状态。
 */
import type { Page } from 'playwright-core'

/** 稳定判定：连续多少帧布局不变 */
const STABLE_FRAMES = 2
/** 稳定等待上限：页面永远在动也要往下走，绝不把录制卡死 */
const MAX_SETTLE_MS = 5000

/** 连续 N 帧「布局指纹」不变才算稳定（对应架构里的「连续 2 帧无布局变化」） */
export async function settleFrameStability(page: Page): Promise<void> {
	await page
		.evaluate(
			(frames) =>
				new Promise<void>((resolve) => {
					const doc = document.documentElement
					/** 布局指纹：文档宽高 + 元素总数，任一变化即视为布局变化。 */
					const measure = () =>
						`${doc.scrollWidth}x${doc.scrollHeight}x${document.querySelectorAll('*').length}`
					let last = measure()
					let stable = 0
					let guard = 0
					/** 逐帧检查：连续 frames 帧不变即稳定；guard 兜底防页面动画永不停歇。 */
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
export async function waitForSilence(getLastEventTs: () => number, silenceMs: number): Promise<void> {
	const started = Date.now()
	while (Date.now() - started < MAX_SETTLE_MS) {
		if (Date.now() - getLastEventTs() >= silenceMs) return
		await sleep(40)
	}
}

/** 极简延时：录制/沉降循环里替代各处零散的 setTimeout Promise 包装。 */
export function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}

/** 坐标保留 2 位小数（CSS px，不乘 dpr） */
export function round2(value: number): number {
	return Math.round(value * 100) / 100
}

/** 数值夹取（点击坐标、计数等写入 IR 前的边界保护）。 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}
