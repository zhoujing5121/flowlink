/**
 * 校验预设与中文业务短句永久回归测试（openspec change: formalize-reference 修订轮 8.2）。
 *
 * 覆盖：预设编译（大小写/格式/正负/日期自动计算/句子式条件必填）、反编译与往返等价、
 * 自定义结构标记、describeRules 业务短句、describeRuleName 映射、ISEMPTY 求值。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let presets
let describeModule
let expression
let validate

async function bundle(entry, name) {
	const outfile = join(tempDir, `${name}.mjs`)
	await build({
		entryPoints: [join(process.cwd(), entry)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
	})
	return import(pathToFileURL(outfile).href)
}

before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-reference-presets-'))
	;[presets, describeModule, expression, validate] = await Promise.all([
		bundle('engine/reference/src/presets.ts', 'presets'),
		bundle('engine/reference/src/describe.ts', 'describe'),
		bundle('engine/reference/src/expression.ts', 'expression'),
		bundle('engine/reference/src/validate.ts', 'validate'),
	])
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

describe('8.2 预设编译', () => {
	test('大小写/格式/正负编译为 validation 字段', () => {
		const compiled = presets.compilePresets({
			...presets.EMPTY_PRESETS,
			caseMode: 'upper',
			format: 'email',
			sign: 'positive',
		})
		assert.deepEqual(compiled, { caseMode: 'upper', format: { preset: 'email' }, sign: 'positive' })
		assert.equal(presets.compilePresets(presets.EMPTY_PRESETS), undefined)
	})

	test('日期自动计算编译为 DATEADD/TODAY 表达式', () => {
		assert.equal(
			presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'today' } }).formula,
			'TODAY()',
		)
		assert.equal(
			presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayPlus', n: 7 } }).formula,
			'DATEADD(TODAY(), 7, "day")',
		)
		assert.equal(
			presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayMinus', n: 3 } }).formula,
			'DATEADD(TODAY(), -3, "day")',
		)
	})

	test('句子式条件必填编译为 NOT(ISEMPTY(label))，可被表达式引擎求值', () => {
		const compiled = presets.compilePresets({ ...presets.EMPTY_PRESETS, requiredWhen: '客户类型' })
		assert.equal(compiled.condition, 'NOT(ISEMPTY(客户类型))')
		const ast = expression.parseExpression(compiled.condition, new Set(['客户类型']))
		assert.equal(expression.evaluateExpression(ast, { 客户类型: '企业' }), true)
		assert.equal(expression.evaluateExpression(ast, { 客户类型: '' }), false)
	})

	test('编译出的公式在日期求值语义下正确', () => {
		const now = new Date('2026-03-15T00:00:00Z')
		const formula = presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayMinus', n: 2 } }).formula
		assert.equal(expression.evaluateExpression(expression.parseExpression(formula), {}, { now }), '2026-03-13')
	})
})

describe('8.2 反编译与往返', () => {
	test('预设往返等价：编译 → 反编译 → 再编译结构一致', () => {
		const cases = [
			{ ...presets.EMPTY_PRESETS, caseMode: 'lower', format: 'phone', sign: 'nonNegative' },
			{ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayPlus', n: 30 } },
			{ ...presets.EMPTY_PRESETS, requiredWhen: '客户类型' },
		]
		for (const preset of cases) {
			const compiled = presets.compilePresets(preset)
			const names = preset.requiredWhen ? [preset.requiredWhen] : []
			const round = presets.decomposeValidation(compiled, names)
			assert.equal(round.custom, false, `往返不应标记自定义：${JSON.stringify(preset)}`)
			assert.equal(presets.presetsRoundTrip(compiled, names), true)
			assert.deepEqual(presets.compilePresets(round.presets), compiled)
		}
	})

	test('手写公式/自定义正则/非句子条件标记 custom', () => {
		assert.equal(presets.decomposeValidation({ formula: '单价 * 数量' }).custom, true)
		assert.equal(presets.decomposeValidation({ format: { pattern: '^ORD-\\d+$' } }).custom, true)
		assert.equal(presets.decomposeValidation({ condition: '客户类型 == "企业"' }, ['客户类型']).custom, true)
		// 句子式条件但引用名不在上下文 → custom
		assert.equal(presets.decomposeValidation({ condition: 'NOT(ISEMPTY(幽灵))' }, ['客户类型']).custom, true)
		// 预设可映射部分仍还原（大小写 + 自定义正则混合）
		const mixed = presets.decomposeValidation({ caseMode: 'upper', format: { pattern: '.*' } })
		assert.equal(mixed.custom, true)
		assert.equal(mixed.presets.caseMode, 'upper')
	})

	test('spec 场景：今天+7 天保存后重开还原', () => {
		const compiled = presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayPlus', n: 7 } })
		assert.equal(compiled.formula, 'DATEADD(TODAY(), 7, "day")')
		const reopened = presets.decomposeValidation(compiled)
		assert.deepEqual(reopened.presets.dateAuto, { mode: 'todayPlus', n: 7 })
	})
})

describe('8.2 中文业务短句', () => {
	test('describeRules 覆盖必填/预设/自定义的措辞', () => {
		const names = ['客户类型']
		assert.equal(describeModule.describeRules({ required: true }), '必填')
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, caseMode: 'upper' }) }),
			'自动转大写',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, format: 'email' }) }),
			'邮箱格式',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, format: 'url' }) }),
			'网址格式',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, sign: 'positive' }) }),
			'必须为正数',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, sign: 'nonPositive' }) }),
			'不能为正数',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayPlus', n: 7 } }) }),
			'自动计算：今天+7 天',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, dateAuto: { mode: 'todayMinus', n: 3 } }) }),
			'自动计算：今天−3 天',
		)
		assert.equal(
			describeModule.describeRules({ validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, requiredWhen: '客户类型' }) }, { referenceNames: names }),
			'当『客户类型』已填写时必填',
		)
		// proposal 示例组合
		assert.equal(
			describeModule.describeRules(
				{ required: true, validation: { caseMode: 'upper', formula: 'DATEADD(TODAY(), 7, "day")' } },
			),
			'必填 · 自动转大写 · 自动计算：今天+7 天',
		)
		// 自定义部分
		assert.equal(
			describeModule.describeRules({ validation: { formula: '单价 * 数量' } }),
			'自动计算（自定义公式）',
		)
		assert.equal(
			describeModule.describeRules({ validation: { condition: '客户类型 == "企业"' } }, { referenceNames: names }),
			'条件必填（自定义）',
		)
		assert.equal(describeModule.describeRules({ validation: { format: { pattern: '.*' } } }), '自定义格式')
	})

	test('短语不含枚举值与表达式语法', () => {
		const summary = describeModule.describeRules({
			required: true,
			validation: presets.compilePresets({ ...presets.EMPTY_PRESETS, caseMode: 'lower', format: 'phone' }),
		})
		assert.ok(!/[A-Za-z_]+\(|caseMode|upper|phone|preset/.test(summary), `出现技术词：${summary}`)
	})

	test('describeRuleName 映射与违规 issue.ruleLabel 一致', () => {
		assert.equal(describeModule.describeRuleName('required'), '必填')
		assert.equal(describeModule.describeRuleName('formula'), '自动计算')
		const result = validate.validateReferences(
			[{ name: 'input_1', label: '客户名称', type: 'string', required: true }],
			{},
		)
		assert.equal(result.issues[0].ruleLabel, '必填')
	})
})
