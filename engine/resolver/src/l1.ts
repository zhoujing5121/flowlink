/**
 * L1：语义候选逐个尝试。
 *
 * 解析约定：
 * - 按 candidates 的既定优先顺序逐个尝试；候选 score 越小越先尝试；
 * - 单个候选多命中时先剔除不可见的隐藏副本（模板 / 通知堆叠），
 *   仅剩一个可见项即直接采用；多个可见才比较几何位置，分差不足则拒绝猜测
 *   并继续尝试后续候选；
 * - 唯一命中但不可见时记为 HIDDEN，供上层决定是否等待或降级。
 */
import type { Candidate, ElementRef, Rect } from '../../schema/src/index.js'
import type { Locator } from 'playwright-core'

import { candidateLocator, describeCandidate } from './candidates.js'
import { ElementNotFoundError } from './errors.js'
import { pickWinner, rankMatches } from './score.js'
import { sortCandidates, type Scope } from './types.js'

export interface L1Options {
	requireVisible: boolean
	ambiguityThreshold: number
}

export interface L1Hit {
	locator: Locator
	score: number
	candidate: Candidate
	matchedCount: number
}

export interface L1Failure {
	/** 所有候选都 0 命中 */
	noMatch: boolean
	/** 命中过多个且分差不足 */
	sawAmbiguous: boolean
	/** 命中过唯一但不可见 */
	sawHidden: boolean
	detail: string[]
}

/** 单个命中的矩形 + 可见性（一次 evaluate 取齐，避免 N 次 boundingBox/isVisible） */
interface RectWithVisibility {
	rect: Rect
	visible: boolean
}

/**
 * 从页面取所有匹配元素的视口矩形与可见性。
 * 可见性语义与录制端 validateCandidate / hash.ts 的 isVisible 一致：
 * `checkVisibility`（含透明度与 CSS 判定），off-screen 但已渲染仍算可见。
 */
async function rectsOf(locator: Locator): Promise<RectWithVisibility[]> {
	return locator.evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect()
			const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean }
			let visible = false
			if (typeof anyEl.checkVisibility === 'function') {
				try {
					visible = anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
				} catch {
					visible = el.getClientRects().length > 0
				}
			} else visible = el.getClientRects().length > 0
			return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, visible }
		}),
	)
}

/**
 * 解析一个 ElementRef 的语义候选。成功返回唯一 Locator；所有候选均不可用时
 * 抛 ElementNotFoundError，并优先保留 AMBIGUOUS/HIDDEN 等可供上层降级决策的原因。
 * 候选按 schema 约定的升序优先级稳定排序；几何分只在同一候选多命中时用于消歧，
 * 不会让低优先级候选越过已成功解析的高优先级候选。
 */
export async function resolveL1(
	target: ElementRef,
	scope: Scope,
	opts: L1Options,
	log: (msg: string) => void,
): Promise<L1Hit> {
	const candidates = sortCandidates(target.candidates)
	const failure: L1Failure = { noMatch: true, sawAmbiguous: false, sawHidden: false, detail: [] }
	const observed = target.observed.rect
	const viewport = target.observed.viewport

	if (candidates.length === 0) {
		throw new ElementNotFoundError('INVALID_REF', target, 'ElementRef.candidates 为空')
	}

	for (const candidate of candidates) {
		const label = describeCandidate(candidate)
		let locator: Locator
		try {
			locator = candidateLocator(scope, candidate)
		} catch (err) {
			// 单条候选不合法不该让整次解析失败，记录下来试下一条
			failure.detail.push(`${label}: 构造 locator 失败（${(err as Error).message}）`)
			continue
		}

		let count: number
		try {
			count = await locator.count()
		} catch (err) {
			failure.detail.push(`${label}: count() 失败（${(err as Error).message}）`)
			continue
		}

		if (count === 0) {
			failure.detail.push(`${label}: 0 命中`)
			log(`L1 ${label} → 0 命中`)
			continue
		}
		failure.noMatch = false

		if (count === 1) {
			const visible = await locator.isVisible()
			if (visible || !opts.requireVisible) {
				log(`L1 ${label} → 唯一命中${visible ? '' : '（可见性未校验）'}`)
				return { locator, score: 100, candidate, matchedCount: 1 }
			}
			failure.sawHidden = true
			failure.detail.push(`${label}: 唯一命中但不可见`)
			log(`L1 ${label} → 命中但不可见`)
			continue
		}

		// 多命中只在当前候选内评分；若无法安全选出唯一项，继续按原顺序尝试下一候选。
		let rects: RectWithVisibility[]
		try {
			rects = await rectsOf(locator)
		} catch (err) {
			failure.detail.push(`${label}: 取矩形失败（${(err as Error).message}）`)
			continue
		}
		const indexed = rects.map((entry, index) => ({ index, ...entry }))
		// 与录制端同一语义：隐藏副本（模板 / 堆叠通知）不参与竞争，先按可见性预过滤。
		const visibleOnes = indexed.filter((it) => it.visible)
		if (visibleOnes.length === 1) {
			const only = visibleOnes[0]!
			log(`L1 ${label} → ${count} 命中但仅 1 个可见，采用可见项`)
			return { locator: locator.nth(only.index), score: 100, candidate, matchedCount: count }
		}
		if (visibleOnes.length === 0) {
			failure.sawHidden = true
			failure.detail.push(`${label}: ${count} 命中但全部不可见`)
			log(`L1 ${label} → ${count} 命中全部不可见`)
			continue
		}
		const ranked = rankMatches(visibleOnes, (it) => it.rect, observed, viewport)
		const picked = pickWinner(ranked, opts.ambiguityThreshold)
		const top = ranked[0]

		if (picked.ambiguous) {
			failure.sawAmbiguous = true
			const [a, b] = picked.runnersUp
			failure.detail.push(
				`${label}: ${count} 命中且 top1/top2 分差不足 15%` +
					`（${a?.score ?? 0} vs ${b?.score ?? 0}）`,
			)
			log(`L1 ${label} → ${count} 命中，歧义（${a?.score ?? 0} vs ${b?.score ?? 0}），降级`)
			continue
		}
		if (!picked.winner || !top) {
			failure.detail.push(`${label}: ${count} 命中但无法排序`)
			continue
		}

		const winnerLocator = locator.nth(picked.winner.item.index)
		const visible = await winnerLocator.isVisible()
		if (!visible && opts.requireVisible) {
			failure.sawHidden = true
			failure.detail.push(`${label}: 多命中中几何最优者不可见（score=${picked.winner.score}）`)
			continue
		}
		log(`L1 ${label} → ${count} 命中，几何最优 score=${picked.winner.score}`)
		return {
			locator: winnerLocator,
			score: picked.winner.score,
			candidate,
			matchedCount: count,
		}
	}

	const code = failure.sawAmbiguous ? 'AMBIGUOUS' : failure.sawHidden ? 'HIDDEN' : 'NO_MATCH'
	const head =
		code === 'AMBIGUOUS'
			? '所有候选都无法唯一确定元素（top1/top2 分差 < 15%，拒绝猜测）'
			: code === 'HIDDEN'
				? '命中了元素但不可见/不可交互'
				: '所有语义候选均未命中'
	throw new ElementNotFoundError(code, target, head, {
		level: 'L1',
		candidates: candidates.map(describeCandidate),
		detail: failure.detail,
	})
}
