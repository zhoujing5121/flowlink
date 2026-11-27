/**
 * engine/reference 共享包永久回归测试（openspec change: simplify-reference-rules 收缩版）。
 *
 * 覆盖：类型目录封闭性与显示映射、label 启发式（成对日期/无证据兜底/去重）、
 * locator 派生（页面 · 控件 / 地址栏 · 系统名 / 证据缺失留空）、
 * 迁移转换器 validationToRulesText（各规则组合 → 中文句子）、
 * 收缩版闸门求值器（必填缺失清单、空串注入、附件绝对路径注入、越界违规）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bundle, cleanupBundleTemp } from '../../helpers/bundle.mjs'

let tempDir
let catalog
let labels
let describeModule
let validate


before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-reference-'))
	;[catalog, labels, describeModule, validate] = await Promise.all([
		bundle('engine/reference/src/type-catalog.ts', 'type-catalog'),
		bundle('engine/reference/src/labels.ts', 'labels'),
		bundle('engine/reference/src/describe.ts', 'describe'),
		bundle('engine/reference/src/validate.ts', 'validate'),
	])
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
	await cleanupBundleTemp()
})

describe('类型目录', () => {
	test('封闭且显示映射一一对应', () => {
		assert.deepEqual(catalog.REFERENCE_TYPES, [
			'url', 'string', 'integer', 'decimal', 'date', 'secret',
			'excel', 'word', 'csv', 'md', 'file',
		])
		const displays = Object.values(catalog.TYPE_DISPLAY)
		assert.equal(new Set(displays).size, displays.length)
		assert.equal(catalog.displayType('url'), '网址')
		assert.equal(catalog.displayType('md'), 'Markdown')
		assert.equal(catalog.isFileReferenceType('csv'), true)
		assert.equal(catalog.isFileReferenceType('string'), false)
	})

	test('旧类型映射规则保持', () => {
		assert.deepEqual(catalog.mapLegacyType('email'), { type: 'string', formatPreset: 'email' })
		assert.deepEqual(catalog.mapLegacyType('number', '3.5'), { type: 'decimal' })
	})
})

describe('label 启发式', () => {
	test('成对日期 / 去重 / 兜底', () => {
		const out = labels.assignLabels([
			{ key: 'input_1', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 } },
			{ key: 'input_2', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 } },
			{ key: 'input_3', evidence: { inputType: 'text' }, kindHint: 'input' },
			{ key: 'input_4', evidence: { inputType: 'text' }, kindHint: 'input' },
		])
		assert.deepEqual(out, ['创建日期-开始', '创建日期-结束', '文本输入', '文本输入 2'])
	})
})

describe('locator 派生', () => {
	test('「页面 · 控件」：systemName 优先，控件取文本证据', () => {
		assert.equal(
			labels.deriveLocator('input', { labelText: '客户名称', inputType: 'text' }, '订单系统', 'https://a.local/x'),
			'订单系统 · 客户名称',
		)
	})

	test('systemName 缺失退 URL 路径；再退主机名', () => {
		assert.equal(
			labels.deriveLocator('input', { placeholder: '搜索' }, undefined, 'https://erp.local/orders/list?x=1'),
			'orders/list · 搜索',
		)
		assert.equal(
			labels.deriveLocator('input', { placeholder: '搜索' }, undefined, 'https://erp.local/'),
			'erp.local · 搜索',
		)
	})

	test('url 变量「地址栏 · 系统名」；无文本证据时控件用语义名', () => {
		assert.equal(labels.deriveLocator('url', {}, '订单系统', 'https://a.local'), '地址栏 · 订单系统')
		assert.equal(
			labels.deriveLocator('select', {}, '订单系统', 'https://a.local'),
			'订单系统 · 下拉框',
		)
		assert.equal(labels.deriveLocator('password', { inputType: 'password' }, '订单系统', 'https://a.local'), '订单系统 · 密码框')
	})

	test('证据缺失（无页面身份）留空不编造', () => {
		assert.equal(labels.deriveLocator('input', { labelText: '客户名称' }, undefined, undefined), '')
		assert.equal(labels.deriveLocator('url', {}, undefined, undefined), '')
	})
})

describe('迁移转换器 validationToRulesText', () => {
	test('各规则组合 → 中文句子（；连接）', () => {
		assert.equal(
			describeModule.validationToRulesText({ caseMode: 'upper', format: { preset: 'email' } }, []),
			'自动转大写；必须是邮箱格式',
		)
		assert.equal(describeModule.validationToRulesText({ format: { preset: 'url' } }, []), '必须是网址格式')
		assert.equal(describeModule.validationToRulesText({ format: { preset: 'phone' } }, []), '必须是手机号格式')
		assert.equal(describeModule.validationToRulesText({ format: { pattern: '^A' } }, []), '值必须匹配自定义格式要求')
		assert.equal(describeModule.validationToRulesText({ sign: 'positive' }, []), '必须为正数')
		assert.equal(describeModule.validationToRulesText({ sign: 'nonPositive' }, []), '不能为正数')
	})

	test('日期公式转「今天 ± N 天」句子；手写公式原样内联', () => {
		assert.equal(describeModule.validationToRulesText({ formula: 'TODAY()' }, []), '值自动计算：今天')
		assert.equal(
			describeModule.validationToRulesText({ formula: 'DATEADD(TODAY(), 7, "day")' }, []),
			'值自动计算：今天+7 天',
		)
		assert.equal(
			describeModule.validationToRulesText({ formula: 'DATEADD(TODAY(), -3, "day")' }, []),
			'值自动计算：今天−3 天',
		)
		assert.equal(
			describeModule.validationToRulesText({ formula: '单价 * 2' }, []),
			'值按公式自动计算：单价 * 2',
		)
	})

	test('句子式条件必填还原（label 集合内）；其余条件原样内联；空结构返回空串', () => {
		assert.equal(
			describeModule.validationToRulesText({ condition: 'NOT(ISEMPTY(客户类型))' }, ['客户类型']),
			'当『客户类型』已填写时必填',
		)
		assert.equal(
			describeModule.validationToRulesText({ condition: '客户类型 == "企业"' }, ['客户类型']),
			'满足条件时必填：客户类型 == "企业"',
		)
		assert.equal(describeModule.validationToRulesText(undefined, []), '')
		assert.equal(describeModule.validationToRulesText({}, []), '')
	})

	test('spec 示例组合：转大写 + email 预设 + 今天+7 公式', () => {
		assert.equal(
			describeModule.validationToRulesText(
				{ caseMode: 'upper', format: { preset: 'email' }, formula: 'DATEADD(TODAY(), 7, "day")' },
				[],
			),
			'自动转大写；必须是邮箱格式；值自动计算：今天+7 天',
		)
	})
})

describe('收缩版闸门求值器', () => {
	test('必填缺失一次性收集（对象 label + 原因），非必填空串注入', () => {
		const objects = [
			{ name: 'input_1', label: '客户名称', type: 'string', required: true },
			{ name: 'input_2', label: '邮箱', type: 'string', required: true },
			{ name: 'input_3', label: '备注', type: 'string' },
		]
		const result = validate.validateReferences(objects, {})
		assert.equal(result.ok, false)
		assert.deepEqual(result.issues.map((issue) => issue.label), ['客户名称', '邮箱'])
		assert.ok(result.issues.every((issue) => issue.reason === '必填对象没有值'))
		assert.equal(result.values['input_3'], '', '非必填缺失以空串注入')
		assert.deepEqual(result.injectedEmpty, ['input_3'])
		const filled = validate.validateReferences(objects, { input_1: 'a', input_2: 'b@x.co' })
		assert.equal(filled.ok, true)
	})

	test('规则文本不参与程序侧校验（不解析不拦截）', () => {
		const objects = [
			{ name: 'input_1', label: '邮箱', type: 'string', rules: '必须是邮箱格式', required: false },
		]
		const result = validate.validateReferences(objects, { input_1: 'not-an-email' })
		assert.equal(result.ok, true, '程序不解析 rules，格式错误不拦截')
	})

	test('附件绝对路径注入与越界违规', () => {
		const artifactsDir = join(tempDir, 'artifacts-gate')
		const ok = validate.validateReferences(
			[
				{ name: 'file_1', label: '附件', type: 'csv', required: true, file: { name: 'a.csv', path: 'references/a.csv' } },
			],
			{},
			{ artifactsDir },
		)
		assert.equal(ok.ok, true, JSON.stringify(ok.issues))
		assert.ok(ok.values['file_1'].startsWith(artifactsDir) && ok.values['file_1'].endsWith('a.csv'))
		const bad = validate.validateReferences(
			[{ name: 'file_1', label: '附件', type: 'file', file: { name: 'e', path: 'references/../../e.txt' } }],
			{},
			{ artifactsDir },
		)
		assert.equal(bad.ok, false)
		assert.ok(/越界/.test(bad.issues[0].reason))
		assert.equal(bad.values['file_1'], '')
	})
})
