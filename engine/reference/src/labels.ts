/**
 * Reference 业务命名（label）启发式：录制端、schema v2→v3 迁移回填共用。
 *
 * 规则（spec: recording / reference）：
 * - 证据优先级：关联 label 文本 > placeholder > aria-label > name 属性 > 输入类型语义兜底；
 * - 同页成对的日期输入（开始/结束区间）在共同基础名后缀「-开始」「-结束」；
 * - 同名冲突追加序号（「文本输入 2」）；
 * - 任何兜底命名都用业务化措辞，绝不把机器键风格名（input_1 等）当显示名。
 *
 * 纯函数：证据以结构化平面对象传入，不依赖 recorder/schema 的类型。
 */

/** 单个对象的命名证据（从 ElementRef observed/fingerprint 提取的平面结构） */
export interface LabelEvidence {
	/** 关联 label 文本（可访问名/显式 label 元素文本）——最高优先级 */
	labelText?: string
	placeholder?: string
	ariaLabel?: string
	nameAttr?: string
	/** 输入类型（date/number/email/tel/password/file/…），语义兜底用 */
	inputType?: string
	/** 所在标签页下标：成对日期按同页判定；缺省视为第 0 页 */
	pageIndex?: number
}

/** 对象种类提示（无元素证据时的兜底语义） */
export type LabelKindHint = 'url' | 'input' | 'select' | 'upload' | 'password'

/** 一次命名请求：key 是机器键（仅作关联，不参与显示） */
export interface LabelSeed {
	key: string
	evidence: LabelEvidence
	kindHint?: LabelKindHint
}

/** 证据文本的清洗：压空白、去首尾星号/冒号、限长。 */
function cleanEvidenceText(raw: string | undefined): string | undefined {
	if (typeof raw !== 'string') return undefined
	const text = raw.replace(/\s+/g, ' ').replace(/[*：:]\s*$/, '').trim()
	if (!text) return undefined
	return text.length > 30 ? text.slice(0, 30) : text
}

/** 输入类型是否日期类（成对日期判定用） */
function isDateLikeInput(inputType: string | undefined): boolean {
	if (!inputType) return false
	const t = inputType.toLowerCase()
	return t === 'date' || t === 'datetime-local' || t === 'month' || t === 'week'
}

/** 按输入类型/种类合成的业务化兜底名 */
export function semanticFallbackName(evidence: LabelEvidence, kindHint?: LabelKindHint): string {
	const inputType = evidence.inputType?.toLowerCase()
	if (kindHint === 'url') return '网址'
	if (kindHint === 'password') return '密码'
	if (kindHint === 'upload') return '文件'
	if (kindHint === 'select') return '选项'
	switch (inputType) {
		case 'date':
		case 'datetime-local':
		case 'month':
		case 'week':
			return '日期'
		case 'number':
		case 'range':
			return '数字'
		case 'email':
			return '邮箱'
		case 'tel':
			return '电话'
		case 'url':
			return '网址'
		case 'search':
			return '搜索'
		case 'file':
			return '文件'
		case 'password':
			return '密码'
		default:
			return kindHint === 'input' ? '文本输入' : '文本'
	}
}

/**
 * 单条证据 → 基础业务名（未做成对/去重处理）。
 * 证据优先级：labelText > placeholder > ariaLabel > nameAttr > 类型语义兜底。
 */
export function baseLabelFromEvidence(evidence: LabelEvidence, kindHint?: LabelKindHint): string {
	return (
		cleanEvidenceText(evidence.labelText) ??
		cleanEvidenceText(evidence.placeholder) ??
		cleanEvidenceText(evidence.ariaLabel) ??
		cleanEvidenceText(evidence.nameAttr) ??
		semanticFallbackName(evidence, kindHint)
	)
}

/** 该证据是否完全没有文本证据（只有类型语义兜底）——成对日期放宽匹配用 */
function hasTextEvidence(evidence: LabelEvidence): boolean {
	return Boolean(
		cleanEvidenceText(evidence.labelText) ??
			cleanEvidenceText(evidence.placeholder) ??
			cleanEvidenceText(evidence.ariaLabel) ??
			cleanEvidenceText(evidence.nameAttr),
	)
}

/**
 * 为一组对象生成 label 列表（与 seeds 同序）。
 *
 * 处理顺序：先按证据算基础名 → 同页成对日期加「-开始」「-结束」后缀 →
 * 全局同名去重（追加序号）。成对规则：同页两个日期输入基础名相同即成对；
 * 后来的日期输入完全没有文本证据时，与同页唯一未配对日期配成区间。
 */
export function assignLabels(seeds: readonly LabelSeed[]): string[] {
	const bases = seeds.map((seed) => baseLabelFromEvidence(seed.evidence, seed.kindHint))
	const labels: string[] = [...bases]

	// ---- 同页成对日期 ----
	// pageIndex → 尚未配对的日期输入（数组下标 + 基础名）
	const openDatesByPage = new Map<number, Array<{ index: number; base: string }>>()
	const pairedBases = new Set<string>()
	for (let i = 0; i < seeds.length; i++) {
		const seed = seeds[i]!
		if (!isDateLikeInput(seed.evidence.inputType)) continue
		const pageIndex = seed.evidence.pageIndex ?? 0
		const open = openDatesByPage.get(pageIndex) ?? []
		openDatesByPage.set(pageIndex, open)
		const sameBase = open.find((candidate) => candidate.base === bases[i])
		// 完全没有文本证据的日期输入（只有类型兜底）与同页任一未配对日期配成区间
		const anyOpen = !hasTextEvidence(seed.evidence) ? open[0] : undefined
		const partner = sameBase ?? anyOpen
		if (partner) {
			labels[partner.index] = `${partner.base}-开始`
			labels[i] = `${partner.base}-结束`
			pairedBases.add(partner.base)
			open.splice(open.indexOf(partner), 1)
		} else {
			open.push({ index: i, base: bases[i]! })
		}
	}

	// ---- 全局同名去重（追加序号） ----
	// 已配对的裸基础名先占名册：第三个同基础名的对象会计序号，而不是与区间名混淆。
	const taken = new Set<string>(pairedBases)
	for (let i = 0; i < labels.length; i++) {
		let label = labels[i]!
		if (taken.has(label)) {
			let seq = 2
			while (taken.has(`${label} ${seq}`)) seq++
			label = `${label} ${seq}`
		}
		taken.add(label)
		labels[i] = label
	}
	return labels
}
