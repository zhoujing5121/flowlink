/**
 * 校验规则 → 中文业务短句（openspec change: formalize-reference 修订轮 D7）。
 *
 * 表格校验列、回放闸门违规文案、编辑对话框三处共用同一份措辞，
 * 不出现枚举值与表达式语法；无法映射回预设的结构以「自定义」标记。
 */
import { decomposeValidation } from './presets.js'
import type { ValidationRules } from './validate.js'

/** 违规/规则键 → 中文短语（闸门列表与行级摘要共用） */
export function describeRuleName(rule: string): string {
	switch (rule) {
		case 'required':
			return '必填'
		case 'condition':
			return '条件必填'
		case 'format':
			return '格式'
		case 'sign':
			return '正负'
		case 'type':
			return '类型'
		case 'formula':
			return '自动计算'
		case 'formula-expression':
			return '公式表达式'
		case 'condition-expression':
			return '条件表达式'
		case 'label':
			return '显示名'
		case 'file':
			return '附件'
		default:
			return rule
	}
}

const FORMAT_PHRASES: Record<string, string> = {
	email: '邮箱格式',
	url: '网址格式',
	phone: '手机号格式',
}

const SIGN_PHRASES: Record<string, string> = {
	positive: '必须为正数',
	negative: '必须为负数',
	nonNegative: '不能为负数',
	nonPositive: '不能为正数',
}

export interface DescribeContext {
	/** 合法对象引用名（句子式条件必填的短语还原） */
	referenceNames?: Iterable<string>
}

function describeDateAuto(mode: string, n?: number): string {
	if (mode === 'today') return '自动计算：今天'
	if (mode === 'todayPlus') return `自动计算：今天+${n} 天`
	if (mode === 'todayMinus') return `自动计算：今天−${n} 天`
	return ''
}

/**
 * 对象规则摘要（表格校验列主入口）：
 * 如「必填 · 自动转大写 · 邮箱格式 · 必须为正数 · 自动计算：今天+7 天 · 当『客户类型』已填写时必填」。
 */
export function describeRules(
	input: { required?: boolean; validation?: ValidationRules },
	ctx: DescribeContext = {},
): string {
	const parts: string[] = []
	if (input.required) parts.push('必填')
	const validation = input.validation
	if (validation) {
		if (validation.caseMode === 'upper') parts.push('自动转大写')
		else if (validation.caseMode === 'lower') parts.push('自动转小写')
		if (validation.format?.preset) parts.push(FORMAT_PHRASES[validation.format.preset] ?? `${validation.format.preset} 格式`)
		else if (typeof validation.format?.pattern === 'string' && validation.format.pattern !== '')
			parts.push('自定义格式')
		if (validation.sign) parts.push(SIGN_PHRASES[validation.sign] ?? validation.sign)
		const decomposed = decomposeValidation(validation, ctx.referenceNames ?? [])
		if (validation.formula) {
			const { dateAuto } = decomposed.presets
			parts.push(describeDateAuto(dateAuto.mode, (dateAuto as { n?: number }).n) || '自动计算（自定义公式）')
		}
		if (validation.condition) {
			parts.push(
				decomposed.presets.requiredWhen
					? `当『${decomposed.presets.requiredWhen}』已填写时必填`
					: '条件必填（自定义）',
			)
		}
	}
	return parts.filter(Boolean).join(' · ')
}
