/**
 * Reference 校验求值器：对象集 + 用户值表 → 违规列表 + 解析后值表。
 *
 * 语义（spec: reference / replay-execution）：
 * - 校验范围：必填缺失（含条件必填）、格式预设与自定义正则、正负规则、
 *   公式与条件表达式的求值错误（静态错误也算违规）；
 * - 求值与注入：公式对象的值由表达式求值产生；大小写规则在注入前应用；
 *   非必填且无值/无默认/无公式 → 空串注入（不再硬失败）；
 * - 一次性收集全部违规，不首错即停。
 *
 * 纯函数，无 IO。secret 对象沿用既有行为：值只进当次回放，不落盘。
 */
import type { ReferenceType } from './type-catalog.js'
import { isFileReferenceType } from './type-catalog.js'
import { checkExpression, detectCycles, evaluateExpression, type ExprValue } from './expression.js'
import { describeRuleName } from './describe.js'
import { resolveAttachmentPath } from './files.js'

/** 校验规则（schema VariableSchema.validation 的运行时形态） */
export interface ValidationRules {
	caseMode?: 'preserve' | 'upper' | 'lower'
	format?: { preset?: 'email' | 'url' | 'phone'; pattern?: string }
	sign?: 'positive' | 'negative' | 'nonNegative' | 'nonPositive'
	/** 条件必填：表达式为真时该对象必填 */
	condition?: string
	/** 公式：值由表达式求值产生，用户不可手填 */
	formula?: string
}

/** 参与校验的对象（Variable 的运行时平面形态；label 缺省回退机器名） */
export interface ReferenceObjectInput {
	name: string
	label?: string
	type?: ReferenceType | string
	defaultValue?: string
	secret?: boolean
	required?: boolean
	validation?: ValidationRules
	/** 文件类对象（excel/word/csv/md/file）的持久化附件；回放时解析为工件内绝对路径注入 */
	file?: { name: string; path: string }
}

/** 一条具名违规：可定位到对象与规则 */
export interface ValidationIssue {
	/** 机器键 */
	name: string
	/** 面向用户的对象名（label） */
	label: string
	/** 规则名：required / condition / format / sign / type / formula / condition-expression / formula-expression / label */
	rule: string
	/** 规则的中文业务短语（与表格校验列措辞一致，见 describe.ts；由公共出口统一填充） */
	ruleLabel?: string
	/** 原因（中文，含表达式定位信息） */
	reason: string
}

export interface ValidateOptions {
	/** TODAY()/公式求值的基准时刻；缺省 = 当前时间 */
	now?: Date
	/** 录制工件根目录：提供时把文件类对象的附件解析为工件内绝对路径注入 */
	artifactsDir?: string
}

export interface ValidateResult {
	/** 无违规时为 true */
	ok: boolean
	/** 全部违规（一次性收集） */
	issues: ValidationIssue[]
	/** 解析后值表（机器键 → 注入值；公式求值/大小写/空串填充完成） */
	values: Record<string, string>
	/** 空串注入的对象机器键清单（供回放报告/事后排查） */
	injectedEmpty: string[]
}

/** 出口统一补齐中文规则短语（构造点只写机器规则名） */
function withRuleLabel(issues: ValidationIssue[]): ValidationIssue[] {
	return issues.map((issue) => ({ ...issue, ruleLabel: describeRuleName(issue.rule) }))
}

const FORMAT_PRESETS: Record<'email' | 'url' | 'phone', { re: RegExp; message: string }> = {
	email: { re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: '邮箱格式' },
	url: { re: /^https?:\/\/\S+$/i, message: '网址格式（http/https）' },
	phone: { re: /^1[3-9]\d{9}$/, message: '手机号格式（1 开头 11 位）' },
}

function objectLabel(obj: ReferenceObjectInput): string {
	const label = typeof obj.label === 'string' ? obj.label.trim() : ''
	return label || obj.name
}

/** 表达式引用名：label 优先，缺名回退机器键（与闸门 scope 键一致） */
function referenceName(obj: ReferenceObjectInput): string {
	const label = typeof obj.label === 'string' ? obj.label.trim() : ''
	return label || obj.name
}

function applyCase(value: string, mode: ValidationRules['caseMode']): string {
	if (mode === 'upper') return value.toUpperCase()
	if (mode === 'lower') return value.toLowerCase()
	return value
}

/** 编译用户自定义正则；非法正则返回错误消息 */
function compilePattern(pattern: string): RegExp | string {
	try {
		return new RegExp(pattern)
	} catch {
		return `自定义正则无法编译：${pattern}`
	}
}

/**
 * 静态校验全部表达式（公式/条件），一次性返回违规。
 * 含：语法错误（带行/列）、未知对象引用、未知函数、循环依赖、label 重复。
 */
export function staticValidateExpressions(
	objects: readonly ReferenceObjectInput[],
): ValidationIssue[] {
	const issues: ValidationIssue[] = []
	// label 重复 → 表达式引用有歧义，直接报
	const seenLabels = new Map<string, number>()
	for (const obj of objects) {
		const ref = referenceName(obj)
		seenLabels.set(ref, (seenLabels.get(ref) ?? 0) + 1)
	}
	for (const [ref, count] of seenLabels) {
		if (count > 1) {
			const holders = objects.filter((obj) => referenceName(obj) === ref)
			for (const obj of holders) {
				issues.push({
					name: obj.name,
					label: objectLabel(obj),
					rule: 'label',
					reason: `对象显示名 "${ref}" 重复，表达式引用会产生歧义`,
				})
			}
		}
	}
	const knownNames = objects.map(referenceName)
	const graph: Record<string, string[]> = {}
	for (const obj of objects) {
		const rules = obj.validation
		const ref = referenceName(obj)
		const refs = new Set<string>()
		for (const field of ['formula', 'condition'] as const) {
			const source = rules?.[field]
			if (typeof source !== 'string' || !source.trim()) continue
			const result = checkExpression(source, { knownNames })
			if (!result.ok) {
				issues.push({
					name: obj.name,
					label: objectLabel(obj),
					rule: field === 'formula' ? 'formula-expression' : 'condition-expression',
					reason: `表达式错误（第 ${result.location.line} 行第 ${result.location.column} 列）：${result.message}`,
				})
				continue
			}
			for (const name of result.references) {
				if (name !== ref) refs.add(name)
			}
		}
		if (refs.size) graph[ref] = [...refs]
	}
	for (const cycle of detectCycles(graph)) {
		// cycle = [a, b, a]：去掉首尾的闭环成员序列
		const members = cycle.slice(0, -1)
		for (const ref of members) {
			const obj = objects.find((candidate) => referenceName(candidate) === ref)
			if (!obj) continue
			issues.push({
				name: obj.name,
				label: objectLabel(obj),
				rule: 'formula-expression',
				reason: `表达式循环引用：${members.map((member) => `"${member}"`).join(' → ')}`,
			})
		}
	}
	return withRuleLabel(issues)
}

/** 数字类型（integer/decimal）的值检查：非空值必须是合法数字 */
function checkNumericType(
	obj: ReferenceObjectInput,
	value: string,
	issues: ValidationIssue[],
): number | undefined {
	const parsed = Number(value)
	if (value.trim() === '' || Number.isNaN(parsed)) {
		issues.push({ name: obj.name, label: objectLabel(obj), rule: 'type', reason: '值不是合法数字' })
		return undefined
	}
	if (obj.type === 'integer' && !Number.isInteger(parsed)) {
		issues.push({ name: obj.name, label: objectLabel(obj), rule: 'type', reason: '值必须是整数' })
	}
	return parsed
}

/**
 * 统一校验与求值。步骤：
 * 1. 静态校验表达式（语法/未知名/循环/label 重复）——有错即整体拒绝求值相关部分；
 * 2. 公式对象按依赖序求值出值表；其余对象取 用户值 > 默认值 > 空串；
 * 3. 大小写转换 → 格式/正负/数字类型检查 → 必填与条件必填 → 收集全部违规。
 */
export function validateReferences(
	objects: readonly ReferenceObjectInput[],
	userValues: Readonly<Record<string, string>> = {},
	options: ValidateOptions = {},
): ValidateResult {
	const issues: ValidationIssue[] = []
	const injectedEmpty: string[] = []
	const now = options.now ?? new Date()

	issues.push(...staticValidateExpressions(objects))
	// 有静态错误时：表达式对象的值无法可靠求值，但仍按字面值继续收集其余违规，
	// 让用户一次看到全部问题（静态错误已列出，公式对象值退化为空串）。
	const staticFailed = new Set(issues.map((issue) => issue.name))

	// ---- 公式对象拓扑求值 ----
	const values: Record<string, string> = {}
	const evaluated = new Set<string>()
	const byRef = new Map<string, ReferenceObjectInput>()
	for (const obj of objects) byRef.set(referenceName(obj), obj)
	const inProgress = new Set<string>()

	const evaluateFormula = (obj: ReferenceObjectInput, ref: string): string => {
		if (evaluated.has(obj.name)) return values[obj.name]!
		if (staticFailed.has(obj.name) || inProgress.has(ref)) return ''
		inProgress.add(ref)
		const source = obj.validation!.formula!
		const result = checkExpression(source, { knownNames: objects.map(referenceName) })
		let value = ''
		if (result.ok) {
			const scope: Record<string, ExprValue> = {}
			for (const name of result.references) {
				const dep = byRef.get(name)
				if (!dep) continue
				if (dep.validation?.formula) scope[name] = evaluateFormula(dep, name)
				else scope[name] = typedValueOf(dep)
			}
			try {
				const computed = evaluateExpression(result.ast, scope, { now })
				value = stringifyValue(computed)
			} catch (error) {
				issues.push({
					name: obj.name,
					label: objectLabel(obj),
					rule: 'formula',
					reason: `公式求值失败：${error instanceof Error ? error.message : String(error)}`,
				})
				value = ''
			}
		}
		inProgress.delete(ref)
		evaluated.add(obj.name)
		values[obj.name] = value
		return value
	}

	/** 非公式对象的原始注入值：用户值 > 默认值 > 空串（secret 同规则） */
	function rawValueOf(obj: ReferenceObjectInput): string {
		const user = userValues[obj.name]
		if (typeof user === 'string') return user
		if (typeof obj.defaultValue === 'string') return obj.defaultValue
		return ''
	}

	/** 表达式 scope 里的对象值：数字类型转成 number，其余保持字符串 */
	function typedValueOf(obj: ReferenceObjectInput): ExprValue {
		const value = rawValueOf(obj)
		if ((obj.type === 'integer' || obj.type === 'decimal') && value !== '') {
			const parsed = Number(value)
			if (!Number.isNaN(parsed)) return parsed
		}
		return value
	}

	for (const obj of objects) {
		if (obj.validation?.formula) evaluateFormula(obj, referenceName(obj))
	}

	// ---- 非公式对象取值 + 大小写 + 逐项规则检查 ----
	for (const obj of objects) {
		const rules = obj.validation
		if (rules?.formula) continue // 公式对象值已由求值产生
		// 文件类对象的附件：值 = 工件内绝对路径（upload 步骤直接可用），不做大小写/格式/正负检查。
		// 路径必须留在 <artifactsDir>/references/ 内，越界即具名违规。
		if (obj.file && isFileReferenceType(obj.type)) {
			if (options.artifactsDir) {
				try {
					values[obj.name] = resolveAttachmentPath(options.artifactsDir, obj.file.path)
				} catch (error) {
					values[obj.name] = ''
					issues.push({
						name: obj.name,
						label: objectLabel(obj),
						rule: 'file',
						reason: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				values[obj.name] = ''
			}
			continue
		}
		let value = rawValueOf(obj)
		const wasEmpty = value === ''
		value = applyCase(value, rules?.caseMode)
		values[obj.name] = value
		if (wasEmpty && typeof userValues[obj.name] !== 'string' && typeof obj.defaultValue !== 'string') {
			injectedEmpty.push(obj.name)
		}

		// 数字类型检查（非空值）
		let numeric: number | undefined
		if (obj.type === 'integer' || obj.type === 'decimal') {
			if (value !== '') numeric = checkNumericType(obj, value, issues)
		}

		// 正负规则
		const sign = rules?.sign
		if (sign && numeric !== undefined) {
			const violated =
				(sign === 'positive' && !(numeric > 0)) ||
				(sign === 'negative' && !(numeric < 0)) ||
				(sign === 'nonNegative' && !(numeric >= 0)) ||
				(sign === 'nonPositive' && !(numeric <= 0))
			if (violated) {
				issues.push({ name: obj.name, label: objectLabel(obj), rule: 'sign', reason: `值 ${value} 违反正负规则（${sign}）` })
			}
		}

		// 格式规则（仅检查非空值）
		if (value !== '') {
			const format = rules?.format
			if (format?.preset) {
				const preset = FORMAT_PRESETS[format.preset]
				if (!preset.re.test(value)) {
					issues.push({ name: obj.name, label: objectLabel(obj), rule: 'format', reason: `值不符合${preset.message}` })
				}
			}
			if (typeof format?.pattern === 'string' && format.pattern !== '') {
				const compiled = compilePattern(format.pattern)
				if (typeof compiled === 'string') {
					issues.push({ name: obj.name, label: objectLabel(obj), rule: 'format', reason: compiled })
				} else if (!compiled.test(value)) {
					issues.push({ name: obj.name, label: objectLabel(obj), rule: 'format', reason: `值不匹配自定义正则 ${format.pattern}` })
				}
			}
		}
	}

	// ---- 必填与条件必填（表达式可用全部已解析值，scope 按引用名=label 组织） ----
	const scope: Record<string, ExprValue> = {}
	for (const obj of objects) {
		let value: ExprValue = values[obj.name] ?? ''
		if ((obj.type === 'integer' || obj.type === 'decimal') && value !== '') {
			const parsed = Number(value)
			if (!Number.isNaN(parsed)) value = parsed
		}
		scope[referenceName(obj)] = value
	}
	for (const obj of objects) {
		const isEmpty = (values[obj.name] ?? '') === ''
		if (!isEmpty) continue
		const label = objectLabel(obj)
		if (obj.required) {
			issues.push({ name: obj.name, label, rule: 'required', reason: '必填对象没有值' })
			continue
		}
		const condition = obj.validation?.condition
		if (typeof condition === 'string' && condition.trim() && !staticFailed.has(obj.name)) {
			const result = checkExpression(condition, { knownNames: objects.map(referenceName) })
			if (result.ok) {
				try {
					const hit = evaluateExpression(result.ast, scope, { now })
					if (hit === true) {
						issues.push({ name: obj.name, label, rule: 'condition', reason: '条件必填：条件表达式为真但对象没有值' })
					} else if (hit !== false) {
						issues.push({ name: obj.name, label, rule: 'condition', reason: '条件必填表达式结果不是布尔值' })
					}
				} catch (error) {
					issues.push({
						name: obj.name,
						label,
						rule: 'condition',
						reason: `条件表达式求值失败：${error instanceof Error ? error.message : String(error)}`,
					})
				}
			}
			// 静态错误已在 staticValidateExpressions 报过，不重复
		}
	}

	return { ok: withRuleLabel(issues).length === 0, issues: withRuleLabel(issues), values, injectedEmpty }
}

function stringifyValue(value: ExprValue): string {
	if (typeof value === 'number') return String(value)
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return value
}
