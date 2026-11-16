/**
 * 步骤级 settle 沉降（schema BaseStepSchema.settle 的执行端实现）。
 *
 * 语义：该步执行**前**让页面稳定下来（可选网络空闲 + DOM 静默），
 * 用于慢过渡（登录后首屏、提交后大刷新、跨系统跳转）之后的第一个动作步骤。
 *
 * 尽力而为：到达 maxMs 上限不报错、只记日志——沉降失败不算步骤失败，
 * 正确性交给后续的元素出现等待与 expect/assert 校验判定
 * （与 actions.ts 的 bestEffortNetworkIdle 同一哲学：长轮询站点不该被卡死）。
 */
import type { Page } from 'playwright-core'

export interface SettleOptions {
	networkIdle?: boolean
	/** 距最后一次 DOM 变更至少这么多毫秒才算静默。 */
	domQuietMs?: number
	/** 整个沉降等待的总上限（毫秒）；缺省 10000。 */
	maxMs?: number
}

export const SETTLE_DEFAULT_MAX_MS = 10_000

/**
 * 等待页面沉降。两个维度独立执行、共享同一个 maxMs 预算：
 * 1. networkIdle: waitForLoadState('networkidle')，超时只记日志；
 * 2. domQuietMs: 轮询"距最后一次 DOM 变更 ≥ domQuietMs"，到总上限不报错。
 */
export async function waitForSettle(
	page: Page,
	settle: SettleOptions,
	log: (msg: string) => void,
): Promise<void> {
	const maxMs = settle.maxMs ?? SETTLE_DEFAULT_MAX_MS
	const deadline = Date.now() + maxMs

	if (settle.networkIdle) {
		const budget = Math.max(0, deadline - Date.now())
		try {
			await page.waitForLoadState('networkidle', { timeout: budget })
			log(`networkIdle ✓（${Date.now() - (deadline - maxMs)}ms 内达成）`)
		} catch {
			log(`networkIdle 未在 ${budget}ms 内达成（可能是长轮询站点），继续执行`)
		}
	}

	if (settle.domQuietMs !== undefined && settle.domQuietMs > 0) {
		const quietMs = settle.domQuietMs
		// 注入探针：失败（页面未 ready/已关闭）时退化为跳过 DOM 静默判定。
		const armed = await page
			.evaluate(() => {
				const w = window as unknown as {
					__rrSettleProbe?: { disconnect: () => void }
					__rrSettleLast?: number
				}
				w.__rrSettleProbe?.disconnect()
				w.__rrSettleLast = performance.now()
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						// L2 临时标记不算"页面有变化"（与 NO_EFFECT 探针同规则）
						if (record.type === 'attributes') {
							const name = record.attributeName ?? ''
							if (name.startsWith('data-rr-')) continue
						}
						w.__rrSettleLast = performance.now()
						break
					}
				})
				observer.observe(document, {
					subtree: true,
					childList: true,
					attributes: true,
					characterData: true,
				})
				w.__rrSettleProbe = observer
				return true
			})
			.catch(() => false)
		if (!armed) {
			log('DOM 静默探针注入失败（页面不可用），跳过 domQuiet 判定')
			return
		}
		const pollMs = Math.min(100, quietMs)
		let settledAt: number | undefined
		while (Date.now() < deadline) {
			// 单次 evaluate 内完成"读取最后变更 + 计算静默时长"，避免两次调用间时钟漂移；
			// 页面在注入后被导航/刷新时 __rrSettleLast 丢失，按"刚变更"处理（继续等待）。
			const quietFor = await page
				.evaluate(
					() =>
						performance.now() -
						((window as unknown as { __rrSettleLast?: number })
							.__rrSettleLast ?? performance.now()),
				)
				.catch(() => -1)
			if (quietFor < 0) {
				log('DOM 静默探针读取失败（页面不可用），跳过 domQuiet 判定')
				break
			}
			if (quietFor >= quietMs) {
				settledAt = Date.now()
				break
			}
			await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
		}
		// 探针必须拆除，避免常驻 observer 影响页面
		await page
			.evaluate(() => {
				const w = window as unknown as { __rrSettleProbe?: { disconnect: () => void } }
				w.__rrSettleProbe?.disconnect()
				delete w.__rrSettleProbe
			})
			.catch(() => undefined)
		if (settledAt !== undefined) log(`DOM 静默 ✓（连续 ${quietMs}ms 无变更）`)
		else log(`DOM 静默未在 ${maxMs}ms 总预算内达成，继续执行`)
	}
}
