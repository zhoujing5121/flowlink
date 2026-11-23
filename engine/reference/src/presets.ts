/**
 * 校验预设 ↔ validation 结构的编译/反编译（openspec change: formalize-reference 修订轮 D7）。
 *
 * 预设是同一 validation 结构的受控视图（不是另一套简化 schema）：
 * - 编译：预设控件选择 → 落盘为既有 validation 字段（与高级区手写表达式等价）；
 * - 反编译：已有结构尽量还原为预设；无法映射的部分标记 custom（默认视图显示「自定义规则」，
 *   仅高级区可编辑）。
 *
 * 纯函数，不依赖其他 engine 包。
 */
import type { ValidationRules } from './validate.js'

/** 大小写预设 */
export type PresetCaseMode = 'preserve' | 'upper' | 'lower'

/** 格式预设（'' = 不限制） */
export type PresetFormat = '' | 'email' | 'url' | 'phone'

/** 正负预设（'' = 不限制） */
export type PresetSign = '' | 'positive' | 'negative' | 'nonNegative' | 'nonPositive'

/** 日期自动计算预设 */
export type PresetDateAuto =
	| { mode: 'manual' }
	| { mode: 'today' }
	| { mode: 'todayPlus'; n: number }
	| { mode: 'todayMinus'; n: number }

/** 预设视图的完整状态 */
export interface ValidationPresets {
	caseMode: PresetCaseMode
	format: PresetFormat
	sign: PresetSign
	dateAuto: PresetDateAuto
	/** 句子式条件必填：当『requiredWhen』已填写时本项必填（对象引用名；'' = 不限制） */
	requiredWhen: string
}

/** 反编译结果：预设 + 是否存在无法映射回预设的自定义部分 */
export interface DecomposedValidation {
	presets: ValidationPresets
	/** true = 结构含预设覆盖不了的部分（自定义正则 / 手写公式或条件），默认视图显示「自定义规则」 */
	custom: boolean
}

export const EMPTY_PRESETS: ValidationPresets = {
	caseMode: 'preserve',
	format: '',
	sign: '',
	dateAuto: { mode: 'manual' },
	requiredWhen: '',
}

/** 日期自动计算天数边界（防止表达式里出现离谱数字） */
export const DATE_AUTO_DAYS_MAX = 3650

function presetDateAutoFormula(preset: PresetDateAuto): string | undefined {
	if (preset.mode === 'today') return 'TODAY()'
	if (preset.mode === 'todayPlus') return `DATEADD(TODAY(), ${preset.n}, "day")`
	if (preset.mode === 'todayMinus') return `DATEADD(TODAY(), -${preset.n}, "day")`
	return undefined
}

/**
 * 编译预设为 validation 结构（与高级区表达式等价）。
 * dateAuto.todayPlus/todayMinus 的 n 取正整数（越界钳制）。
 */
export function compilePresets(presets: ValidationPresets): ValidationRules | undefined {
	const validation: ValidationRules = {}
	if (presets.caseMode !== 'preserve') validation.caseMode = presets.caseMode
	if (presets.format) validation.format = { preset: presets.format }
	if (presets.sign) validation.sign = presets.sign
	const formula = presetDateAutoFormula(presets.dateAuto)
	if (formula) validation.formula = formula
	if (presets.requiredWhen) validation.condition = `NOT(ISEMPTY(${presets.requiredWhen}))`
	return Object.keys(validation).length ? validation : undefined
}

/** 反解公式为日期自动计算预设；非预设形式返回 undefined */
function decomposeFormula(formula: string): PresetDateAuto | undefined {
	const trimmed = formula.trim()
	if (trimmed === 'TODAY()') return { mode: 'today' }
	const plus = /^DATEADD\(TODAY\(\),\s*(\d+),\s*"day"\)$/.exec(trimmed)
	if (plus) {
		const n = Number(plus[1])
		return n >= 1 && n <= DATE_AUTO_DAYS_MAX ? { mode: 'todayPlus', n } : undefined
	}
	const minus = /^DATEADD\(TODAY\(\),\s*-(\d+),\s*"day"\)$/.exec(trimmed)
	if (minus) {
		const n = Number(minus[1])
		return n >= 1 && n <= DATE_AUTO_DAYS_MAX ? { mode: 'todayMinus', n } : undefined
	}
	return undefined
}

/**
 * 反编译 validation 结构为预设视图。
 * referenceNames 提供合法对象引用名集合（句子式条件必填的还原依赖它）。
 */
export function decomposeValidation(
	validation: ValidationRules | undefined,
	referenceNames: Iterable<string> = [],
): DecomposedValidation {
	if (!validation) return { presets: { ...EMPTY_PRESETS }, custom: false }
	const presets: ValidationPresets = { ...EMPTY_PRESETS }
	let custom = false

	presets.caseMode =
		validation.caseMode === 'upper' || validation.caseMode === 'lower' ? validation.caseMode : 'preserve'

	if (validation.format) {
		const preset = validation.format.preset
		if (preset === 'email' || preset === 'url' || preset === 'phone') {
			presets.format = preset
			if (typeof validation.format.pattern === 'string' && validation.format.pattern !== '') custom = true
		} else {
			// 只有自定义正则、没有预设 → 格式部分属自定义
			presets.format = ''
			custom = true
		}
	}

	presets.sign =
		validation.sign === 'positive' ||
		validation.sign === 'negative' ||
		validation.sign === 'nonNegative' ||
		validation.sign === 'nonPositive'
			? validation.sign
			: ''

	if (typeof validation.formula === 'string' && validation.formula.trim() !== '') {
		const dateAuto = decomposeFormula(validation.formula)
		if (dateAuto) presets.dateAuto = dateAuto
		else {
			presets.dateAuto = { mode: 'manual' }
			custom = true
		}
	}

	if (typeof validation.condition === 'string' && validation.condition.trim() !== '') {
		const names = new Set(referenceNames)
		const match = /^NOT\(ISEMPTY\((.+)\)\)$/.exec(validation.condition.trim())
		const referenced = match?.[1]?.trim()
		if (referenced && names.has(referenced)) {
			presets.requiredWhen = referenced
		} else {
			custom = true
		}
	}

	return { presets, custom }
}

/** 预设往返等价判断（单测与渲染层可复用）：编译(decompile(x)) 与 x 的预设部分一致 */
export function presetsRoundTrip(
	validation: ValidationRules | undefined,
	referenceNames: Iterable<string> = [],
): boolean {
	const first = decomposeValidation(validation, referenceNames)
	if (first.custom) return false
	const compiled = compilePresets(first.presets)
	const second = decomposeValidation(compiled, referenceNames)
	return !second.custom && JSON.stringify(second.presets) === JSON.stringify(first.presets)
}
