/**
 * L2：stableHash 指纹精确匹配。
 *
 * 流程（计划里定死的）：
 *   page.evaluate 内按指纹字段筛元素 → 命中者打 `data-rr-target=<uid>` →
 *   Node 侧用候选 uid 转 Locator → action 结束后由 `release()` 删除标记。
 *
 * 为什么标记要留到 action 之后才删：Locator 是靠这个属性定位的，
 * resolve 返回后立刻删会让 locator 失效。`release` 由 executor 在 finally 调用；
 * 即使调用方忘了，下一次 L2 采集开头也会把历史标记全部清掉（自愈）。
 *
 * 两级匹配策略：
 *   hash  —— 在 Node 侧重算候选指纹，必须与 flow 中的 stableHash 完全相等（首选路径）；
 *   attrs —— hash 无命中时，回退为 tag、role、name 和录制属性逐项全等比较；
 *            回退仍是精确匹配，不做相似度匹配，也不以 nodePath 单独容错。
 */
import type { ElementRef } from '../../schema/src/index.js'
import type { Locator } from 'playwright-core'

import { ElementNotFoundError } from './errors.js'
import {
	collectFingerprintCandidates,
	computeStableHash,
	NAME_KEEPALIVE_SOURCE,
	removeFingerprintMarkers,
	STABLE_ATTR_POLICY,
	type InPageCandidate,
} from './hash.js'
import { pickWinner, rankMatches } from './score.js'
import type { Scope } from './types.js'

export const L2_MARKER = 'data-rr-target'

/** L2 只接收解析策略，不暴露页面采集实现细节；可见性与歧义门槛由调用方统一配置。 */
export interface L2Options {
	requireVisible: boolean
	ambiguityThreshold: number
	maxFingerprintMatches: number
}

export interface L2Hit {
	/** 通过本次临时标记构造的唯一 Locator；须在 release 前完成对应 action。 */
	locator: Locator
	score: number
	strategy: 'hash' | 'attrs'
	matched: number
	/** 清理页面临时属性；调用方应在 action 的 finally 中调用，允许重复清理。 */
	release: () => Promise<void>
}

/**
 * 在指定 Page/Frame 作用域中执行 L2 精确指纹匹配。
 * 页面候选先按 tag/role/name/录制属性过滤，再以 stableHash 优先、字段全等为回退；
 * 几何信息只用于区分多个精确候选，分差不足时拒绝猜测并抛出带原因码的错误。
 */
export async function resolveL2(
	target: ElementRef,
	scope: Scope,
	opts: L2Options,
	log: (msg: string) => void,
): Promise<L2Hit> {
	const fingerprint = target.fingerprint
	let candidates: InPageCandidate[] = []

	const strip = async (): Promise<void> => {
		try {
			await scope.evaluate(removeFingerprintMarkers, { marker: L2_MARKER })
		} catch {
			/* 页面可能已经跳走/关闭，清理失败不影响主流程 */
		}
	}

	try {
		// 调用方可能未安装垫片；使用原始字符串注入，避免经过 keepNames 转换。
		await scope.evaluate(NAME_KEEPALIVE_SOURCE).catch(() => undefined)
		// 采集阶段仅用指纹字段筛选并打临时标记，后续定位必须仍指向本次采集的命中项。
		candidates = await scope.evaluate(collectFingerprintCandidates, {
			policy: STABLE_ATTR_POLICY,
			tag: fingerprint.tag,
			role: fingerprint.role,
			name: fingerprint.accessibleName,
			attrs: fingerprint.attrs,
			marker: L2_MARKER,
			limit: opts.maxFingerprintMatches,
		})
	} catch (err) {
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 页面内指纹采集失败', {
			level: 'L2',
			cause: (err as Error).message,
		})
	}

	if (candidates.length === 0) {
		await strip()
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 指纹未在页面中找到任何匹配元素', {
			level: 'L2',
			fingerprint: {
				tag: fingerprint.tag,
				role: fingerprint.role,
				accessibleName: fingerprint.accessibleName,
				attrs: fingerprint.attrs,
			},
		})
	}

	// 首选 stableHash 精确匹配。录制端可能把 nodePath 纳入摘要，因此只有原指纹含该字段时才参与重算。
	const useNodePath = fingerprint.nodePath !== undefined
	const exact = candidates.filter((c) => {
		const hash = computeStableHash({
			tag: c.tag,
			role: c.role,
			accessibleName: c.name,
			attrs: c.attrs,
			...(useNodePath ? { nodePath: c.nodePath } : {}),
		})
		return hash === fingerprint.stableHash
	})
	const strategy: 'hash' | 'attrs' = exact.length > 0 ? 'hash' : 'attrs'
	// 只在 hash 没有任何命中时扩大到属性全等候选；有 hash 命中时不把回退候选混入评分池。
	const pool = exact.length > 0 ? exact : candidates
	if (strategy === 'attrs') {
		log(
			`L2 stableHash 未命中（flow 里 ${fingerprint.stableHash.slice(0, 8)}…），` +
				`退化到指纹字段全等匹配（${candidates.length} 个候选）`,
		)
	}

	const observed = target.observed.rect
	const viewport = target.observed.viewport
	// 几何分数只负责多个精确候选间的消歧；分差不足就拒绝选择，不降低字段匹配标准。
	const ranked = rankMatches(pool, (c) => c.rect, observed, viewport)
	const picked = pickWinner(ranked, opts.ambiguityThreshold)

	if (picked.ambiguous) {
		await strip()
		const [a, b] = picked.runnersUp
		throw new ElementNotFoundError('AMBIGUOUS', target, 'L2 指纹命中多个元素且几何分差不足 15%', {
			level: 'L2',
			strategy,
			scores: [a?.score ?? 0, b?.score ?? 0],
			matched: pool.length,
		})
	}

	const winner = picked.winner
	if (!winner) {
		await strip()
		throw new ElementNotFoundError('NO_MATCH', target, 'L2 指纹候选无法排序', {
			level: 'L2',
			strategy,
		})
	}

	const locator = scope.locator(`[${L2_MARKER}="${winner.item.uid}"]`)
	const count = await locator.count()
	if (count !== 1) {
		await strip()
		throw new ElementNotFoundError('AMBIGUOUS', target, `L2 标记后命中 ${count} 个元素`, {
			level: 'L2',
			strategy,
			uid: winner.item.uid,
		})
	}

	if (opts.requireVisible && !winner.item.visible) {
		await strip()
		throw new ElementNotFoundError('HIDDEN', target, 'L2 命中元素但不可见', {
			level: 'L2',
			strategy,
			uid: winner.item.uid,
		})
	}

	log(
		`L2 ${strategy} 命中：uid=${winner.item.uid} score=${winner.score} ` +
			`（候选池 ${pool.length}）`,
	)

	return {
		locator,
		score: winner.score,
		strategy,
		matched: pool.length,
		release: strip,
	}
}
