/**
 * 结构化校验 → 中文规则句子（迁移转换器，openspec change: simplify-reference-rules D2）。
 *
 * 仅 schema v3→v4 迁移调用：把存量 `validation` 各规则经语义转换为一段中文句子
 * （多条以「；」连接）写入自由文本 `rules`。转换后程序不再解析这些文本；
 * UI 与闸门文案不依赖本模块。
 */

interface LegacyValidationRules {
	caseMode?: 'preserve' | 'upper' | 'lower'
	format?: { preset?: 'email' | 'url' | 'phone'; pattern?: string }
	sign?: 'positive' | 'negative' | 'nonNegative' | 'nonPositive'
	condition?: string
	formula?: string
}

const FORMAT_SENTENCES: Record<string, string> = {
	email: '必须是邮箱格式',
	url: '必须是网址格式',
	phone: '必须是手机号格式',
}

const SIGN_SENTENCES: Record<string, string> = {
	positive: '必须为正数',
	negative: '必须为负数',
	nonNegative: '不能为负数',
	nonPositive: '不能为正数',
}

/** 反解日期公式为「今天 ± N 天」句子；非预设形式返回 undefined */
function dateFormulaSentence(formula: string): string | undefined {
	const trimmed = formula.trim()
	if (trimmed === 'TODAY()') return '值自动计算：今天'
	const plus = /^DATEADD\(TODAY\(\),\s*(\d+),\s*"day"\)$/.exec(trimmed)
	if (plus) return `值自动计算：今天+${Number(plus[1])} 天`
	const minus = /^DATEADD\(TODAY\(\),\s*-(\d+),\s*"day"\)$/.exec(trimmed)
	if (minus) return `值自动计算：今天−${Number(minus[1])} 天`
	return undefined
}

/**
 * 把 v3 结构化校验转换为中文规则句子（多条以「；」连接）。
 * 无任何规则时返回空串。referenceNames 提供合法对象引用名（句子式条件必填的还原）。
 */
export function validationToRulesText(
	validation: LegacyValidationRules | undefined,
	referenceNames: Iterable<string> = [],
): string {
	if (!validation) return ''
	const parts: string[] = []
	if (validation.caseMode === 'upper') parts.push('自动转大写')
	else if (validation.caseMode === 'lower') parts.push('自动转小写')
	if (validation.format?.preset) {
		parts.push(FORMAT_SENTENCES[validation.format.preset] ?? `必须是${validation.format.preset}格式`)
	} else if (typeof validation.format?.pattern === 'string' && validation.format.pattern !== '') {
		parts.push('值必须匹配自定义格式要求')
	}
	if (validation.sign) parts.push(SIGN_SENTENCES[validation.sign] ?? validation.sign)
	if (typeof validation.formula === 'string' && validation.formula.trim() !== '') {
		parts.push(dateFormulaSentence(validation.formula) ?? `值按公式自动计算：${validation.formula.trim()}`)
	}
	if (typeof validation.condition === 'string' && validation.condition.trim() !== '') {
		const names = new Set(referenceNames)
		const match = /^NOT\(ISEMPTY\((.+)\)\)$/.exec(validation.condition.trim())
		const referenced = match?.[1]?.trim()
		parts.push(
			referenced && names.has(referenced)
				? `当『${referenced}』已填写时必填`
				: `满足条件时必填：${validation.condition.trim()}`,
		)
	}
	return parts.join('；')
}
