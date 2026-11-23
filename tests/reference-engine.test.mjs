/**
 * engine/reference 共享包永久回归测试（openspec change: formalize-reference）。
 *
 * 覆盖：类型目录封闭性与显示映射唯一、label 启发式（成对日期/无证据兜底/去重）、
 * 安全表达式子集（合法求值/语法错误定位/循环引用/未知引用/无 eval）、
 * 校验求值器（必填缺失/格式/正负/公式求值/空串填充/多违规一次性收集）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let catalog
let labels
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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-reference-'))
	;[catalog, labels, expression, validate] = await Promise.all([
		bundle('engine/reference/src/type-catalog.ts', 'type-catalog'),
		bundle('engine/reference/src/labels.ts', 'labels'),
		bundle('engine/reference/src/expression.ts', 'expression'),
		bundle('engine/reference/src/validate.ts', 'validate'),
	])
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

describe('1.1 type-catalog', () => {
	test('类型目录封闭且显示映射一一对应', () => {
		assert.deepEqual(catalog.REFERENCE_TYPES, [
			'url', 'string', 'integer', 'decimal', 'date', 'secret',
			'excel', 'word', 'csv', 'md', 'file',
		])
		const displays = Object.values(catalog.TYPE_DISPLAY)
		assert.equal(new Set(displays).size, displays.length, '显示名必须唯一')
		assert.equal(displays.length, catalog.REFERENCE_TYPES.length, '每个类型都必须有显示名')
		for (const type of catalog.REFERENCE_TYPES) {
			assert.equal(typeof catalog.TYPE_DISPLAY[type], 'string')
			assert.ok(catalog.TYPE_DISPLAY[type].length > 0)
		}
	})

	test('displayType 与 isReferenceType', () => {
		assert.equal(catalog.displayType('url'), '网址')
		assert.equal(catalog.displayType('md'), 'Markdown')
		assert.equal(catalog.displayType('nope'), 'nope')
		assert.equal(catalog.isReferenceType('date'), true)
		assert.equal(catalog.isReferenceType('text'), false, '旧类型不在新目录')
	})

	test('旧类型映射：text/email/number 规则', () => {
		assert.deepEqual(catalog.mapLegacyType('text'), { type: 'string' })
		assert.deepEqual(catalog.mapLegacyType('email'), { type: 'string', formatPreset: 'email' })
		assert.deepEqual(catalog.mapLegacyType('number', '3'), { type: 'integer' })
		assert.deepEqual(catalog.mapLegacyType('number', '3.5'), { type: 'decimal' })
		assert.deepEqual(catalog.mapLegacyType('number'), { type: 'integer' })
		assert.deepEqual(catalog.mapLegacyType('date'), { type: 'date' })
		assert.deepEqual(catalog.mapLegacyType('secret'), { type: 'secret' })
		assert.deepEqual(catalog.mapLegacyType('file'), { type: 'file' })
	})

	test('上传扩展名映射含 .docx 且拒绝未知扩展', () => {
		assert.equal(catalog.referenceTypeFromFileName('a.xlsx'), 'excel')
		assert.equal(catalog.referenceTypeFromFileName('a.xls'), 'excel')
		assert.equal(catalog.referenceTypeFromFileName('a.csv'), 'csv')
		assert.equal(catalog.referenceTypeFromFileName('a.md'), 'md')
		assert.equal(catalog.referenceTypeFromFileName('a.markdown'), 'md')
		assert.equal(catalog.referenceTypeFromFileName('a.docx'), 'word')
		assert.equal(catalog.referenceTypeFromFileName('a.exe'), undefined)
		assert.equal(catalog.referenceTypeFromFileName('noext'), undefined)
		assert.deepEqual([...catalog.REFERENCE_FILE_EXTENSIONS].sort(), ['.csv', '.docx', '.markdown', '.md', '.xls', '.xlsx'])
	})
})

describe('1.2 labels 启发式', () => {
	test('证据优先级 label>placeholder>aria>name>类型兜底', () => {
		const [out] = labels.assignLabels([
			{ key: 'input_1', evidence: { labelText: '客户名称', placeholder: '占位', ariaLabel: 'aria', nameAttr: 'nm', inputType: 'text' } },
		])
		assert.equal(out, '客户名称')
		const [p] = labels.assignLabels([{ key: 'input_1', evidence: { placeholder: '请输入地址', inputType: 'text' } }])
		assert.equal(p, '请输入地址')
		const [a] = labels.assignLabels([{ key: 'input_1', evidence: { ariaLabel: '电话号码', inputType: 'text' } }])
		assert.equal(a, '电话号码')
		const [n] = labels.assignLabels([{ key: 'input_1', evidence: { nameAttr: 'orderNo', inputType: 'text' } }])
		assert.equal(n, 'orderNo')
		const [f] = labels.assignLabels([{ key: 'input_1', evidence: { inputType: 'text' }, kindHint: 'input' }])
		assert.equal(f, '文本输入', '无文本证据时按类型语义兜底，不得出现机器键风格名')
	})

	test('成对日期：共同基础名后缀 -开始/-结束', () => {
		const out = labels.assignLabels([
			{ key: 'input_1', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 } },
			{ key: 'input_2', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 } },
		])
		assert.deepEqual(out, ['创建日期-开始', '创建日期-结束'])
	})

	test('成对日期：第二个日期无文本证据时仍配对，不同页不配对', () => {
		const out = labels.assignLabels([
			{ key: 'input_1', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 } },
			{ key: 'input_2', evidence: { inputType: 'date', pageIndex: 0 }, kindHint: 'input' },
			{ key: 'input_3', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 1 } },
		])
		assert.deepEqual(out, ['创建日期-开始', '创建日期-结束', '创建日期 2'])
	})

	test('同名去重追加序号，兜底名业务化', () => {
		const out = labels.assignLabels([
			{ key: 'url_1', evidence: { pageIndex: 0 }, kindHint: 'url' },
			{ key: 'url_2', evidence: { pageIndex: 0 }, kindHint: 'url' },
			{ key: 'input_1', evidence: { inputType: 'text' }, kindHint: 'input' },
			{ key: 'input_2', evidence: { inputType: 'text' }, kindHint: 'input' },
			{ key: 'input_3', evidence: { inputType: 'text' }, kindHint: 'input' },
		])
		assert.deepEqual(out, ['网址', '网址 2', '文本输入', '文本输入 2', '文本输入 3'])
	})

	test('kindHint 语义兜底：密码/文件/选项', () => {
		const out = labels.assignLabels([
			{ key: 'password', evidence: { inputType: 'password' }, kindHint: 'password' },
			{ key: 'file_1', evidence: { inputType: 'file' }, kindHint: 'upload' },
			{ key: 'select_1', evidence: { inputType: undefined }, kindHint: 'select' },
		])
		assert.deepEqual(out, ['密码', '文件', '选项'])
	})
})

describe('1.3 expression 安全子集', () => {
	const scope = { '金额': 100, '数量': 3, '创建日期-开始': '2026-01-01', '客户': ' abc ' }

	test('合法算术/比较/逻辑求值', () => {
		const ast = expression.parseExpression('金额 * 数量 + 1')
		assert.equal(expression.evaluateExpression(ast, scope), 301)
		assert.equal(expression.evaluateExpression(expression.parseExpression('金额 > 50 and 数量 == 3'), scope), true)
		assert.equal(expression.evaluateExpression(expression.parseExpression('金额 < 50 || 数量 != 3'), scope), false)
		assert.equal(expression.evaluateExpression(expression.parseExpression('!(金额 < 50)'), scope), true)
		assert.equal(expression.evaluateExpression(expression.parseExpression('金额 % 7'), scope), 2)
		assert.equal(expression.evaluateExpression(expression.parseExpression('-金额 + 50'), scope), -50)
	})

	test('日期函数 TODAY/DATEADD/DATEDIFF', () => {
		const now = new Date('2026-03-15T00:00:00Z')
		assert.equal(
			expression.evaluateExpression(expression.parseExpression('DATEADD(TODAY(), 7, "day")'), {}, { now }),
			'2026-03-22',
		)
		assert.equal(
			expression.evaluateExpression(expression.parseExpression('DATEADD("2026-01-31", 1, "month")'), {}, { now }),
			'2026-02-28',
		)
		assert.equal(
			expression.evaluateExpression(expression.parseExpression('DATEDIFF("2026-03-15", "2026-03-20", "day")'), {}, { now }),
			5,
		)
		assert.equal(expression.evaluateExpression(expression.parseExpression('TODAY()'), {}, { now }), '2026-03-15')
	})

	test('文本函数与带连字符 label 引用', () => {
		assert.equal(expression.evaluateExpression(expression.parseExpression('UPPER(TRIM(客户))'), scope), 'ABC')
		assert.equal(expression.evaluateExpression(expression.parseExpression('LEN(TRIM(客户))'), scope), 3)
		assert.equal(expression.evaluateExpression(expression.parseExpression('CONCAT("A", 客户, "!")'), scope), 'A abc !')
		// 创建日期-开始 作为整词引用（knownNames 提供）
		const ast = expression.parseExpression('创建日期-开始', new Set(['创建日期-开始']))
		assert.equal(expression.evaluateExpression(ast, scope), '2026-01-01')
		// 不在 knownNames 时 a-b 语义为减法
		assert.throws(() => expression.evaluateExpression(expression.parseExpression('创建日期-开始'), scope), /没有可用值/)
	})

	test('语法错误带位置', () => {
		try {
			expression.parseExpression('金额 +')
			assert.fail('必须抛错')
		} catch (error) {
			assert.equal(error.name, 'ExpressionError')
			assert.equal(error.location.line, 1)
			assert.ok(error.location.column > 1)
		}
		try {
			expression.parseExpression('金额 * (数量 +')
			assert.fail('必须抛错')
		} catch (error) {
			assert.match(error.message, /意外结束/)
		}
	})

	test('未知引用与未知函数被静态校验拒绝', () => {
		const bad = expression.checkExpression('不存在字段 + 1', { knownNames: ['金额'] })
		assert.equal(bad.ok, false)
		assert.match(bad.message, /不存在的对象/)
		assert.equal(bad.location.column, 1)
		const unknownFn = expression.checkExpression('FOO(金额)', { knownNames: ['金额'] })
		assert.equal(unknownFn.ok, false)
		const good = expression.checkExpression('TODAY()', { knownNames: ['金额'] })
		assert.equal(good.ok, true)
	})

	test('循环引用检测', () => {
		const cycles = expression.detectCycles({ a: ['b'], b: ['c'], c: ['a'], d: ['d'] })
		assert.equal(cycles.length, 2)
		assert.deepEqual(cycles[0], ['a', 'b', 'c', 'a'])
	})

	test('实现不使用 eval/new Function', async () => {
		const { readFile } = await import('node:fs/promises')
		const source = await readFile(join(process.cwd(), 'engine/reference/src/expression.ts'), 'utf8')
		assert.doesNotMatch(source, /\beval\s*\(/)
		assert.doesNotMatch(source, /new\s+Function\s*\(/)
	})
})

describe('1.4 validate 校验求值器', () => {
	const baseNow = new Date('2026-03-15T00:00:00Z')

	test('必填缺失、格式、正负违规一次性收集', () => {
		const objects = [
			{ name: 'input_1', label: '客户名称', type: 'string', required: true },
			{ name: 'input_2', label: '邮箱', type: 'string', validation: { format: { preset: 'email' } } },
			{ name: 'input_3', label: '金额', type: 'integer', validation: { sign: 'positive' } },
			{ name: 'input_4', label: '编号', type: 'string', validation: { format: { pattern: '^ORD-\\d+$' } } },
		]
		const result = validate.validateReferences(objects, {
			input_2: 'not-an-email',
			input_3: '-5',
			input_4: 'WRONG',
		})
		assert.equal(result.ok, false)
		const rules = result.issues.map((issue) => `${issue.name}:${issue.rule}`)
		assert.ok(rules.includes('input_1:required'), '必填缺失必须报告')
		assert.ok(rules.includes('input_2:format'))
		assert.ok(rules.includes('input_3:sign'))
		assert.ok(rules.includes('input_4:format'))
		assert.equal(result.issues.length, 4, '多违规必须一次性收集')
		for (const issue of result.issues) {
			assert.equal(typeof issue.label, 'string')
			assert.ok(issue.label.length > 0)
			assert.ok(issue.reason.length > 0)
		}
	})

	test('非必填空串填充并记录清单', () => {
		const objects = [
			{ name: 'input_1', label: '客户名称', type: 'string', required: true },
			{ name: 'input_2', label: '备注', type: 'string' },
			{ name: 'input_3', label: '来源', type: 'string', defaultValue: 'portal' },
		]
		const result = validate.validateReferences(objects, { input_1: 'abc' })
		assert.equal(result.ok, true)
		assert.equal(result.values.input_1, 'abc')
		assert.equal(result.values.input_2, '', '非必填无值以空串注入')
		assert.equal(result.values.input_3, 'portal', '默认值继续生效')
		assert.deepEqual(result.injectedEmpty, ['input_2'])
	})

	test('大小写转换在注入前应用', () => {
		const objects = [
			{ name: 'input_1', label: '编码', type: 'string', validation: { caseMode: 'upper' } },
			{ name: 'input_2', label: '小写', type: 'string', validation: { caseMode: 'lower' } },
		]
		const result = validate.validateReferences(objects, { input_1: 'abc', input_2: 'XYZ' })
		assert.equal(result.values.input_1, 'ABC')
		assert.equal(result.values.input_2, 'xyz')
	})

	test('公式求值：日期函数与跨对象引用', () => {
		const objects = [
			{ name: 'date_1', label: '创建日期', type: 'date', validation: { formula: 'DATEADD(TODAY(), 7, "day")' } },
			{ name: 'input_1', label: '单价', type: 'decimal' },
			{ name: 'input_2', label: '数量', type: 'integer' },
			{ name: 'input_3', label: '合计', type: 'decimal', validation: { formula: '单价 * 数量' } },
		]
		const result = validate.validateReferences(objects, { input_1: '2.5', input_2: '4' }, { now: baseNow })
		assert.equal(result.ok, true, `不应有违规：${JSON.stringify(result.issues)}`)
		assert.equal(result.values.date_1, '2026-03-22')
		assert.equal(result.values.input_3, '10')
	})

	test('公式循环引用被静态拒绝', () => {
		const objects = [
			{ name: 'a', label: '甲', type: 'integer', validation: { formula: '乙 + 1' } },
			{ name: 'b', label: '乙', type: 'integer', validation: { formula: '甲 + 1' } },
		]
		const result = validate.validateReferences(objects, {})
		assert.equal(result.ok, false)
		assert.ok(result.issues.some((issue) => issue.rule === 'formula-expression' && /循环引用/.test(issue.reason)))
	})

	test('条件必填：表达式为真且缺值才报违规', () => {
		const objects = [
			{ name: 'input_1', label: '紧急', type: 'string' },
			{ name: 'input_2', label: '理由', type: 'string', validation: { condition: '紧急 == "yes"' } },
		]
		const hit = validate.validateReferences(objects, { input_1: 'yes', input_2: '' })
		assert.equal(hit.ok, false)
		assert.ok(hit.issues.some((issue) => issue.rule === 'condition' && issue.name === 'input_2'))
		const miss = validate.validateReferences(objects, { input_1: 'no', input_2: '' })
		assert.equal(miss.ok, true)
		const filled = validate.validateReferences(objects, { input_1: 'yes', input_2: '客户要求' })
		assert.equal(filled.ok, true)
	})

	test('静态语法错误带行/列定位且阻止保存语义', () => {
		const objects = [{ name: 'a', label: '甲', type: 'integer', validation: { formula: '单价 *' } }]
		const result = validate.validateReferences(objects, {})
		assert.equal(result.ok, false)
		const issue = result.issues.find((item) => item.rule === 'formula-expression')
		assert.ok(issue)
		assert.match(issue.reason, /第 1 行第 \d+ 列/)
	})

	test('整数类型与非数字值', () => {
		const objects = [{ name: 'a', label: '数量', type: 'integer' }]
		const bad = validate.validateReferences(objects, { a: 'abc' })
		assert.ok(bad.issues.some((issue) => issue.rule === 'type'))
		const frac = validate.validateReferences(objects, { a: '3.5' })
		assert.ok(frac.issues.some((issue) => issue.rule === 'type' && /整数/.test(issue.reason)))
		const ok = validate.validateReferences(objects, { a: '3' })
		assert.equal(ok.ok, true)
	})

	test('10.5 文件类对象附件：回放注入工件内绝对路径', () => {
		const artifactsDir = join(tempDir, 'artifacts-rec')
		const objects = [
			{ name: 'file_1', label: '客户清单', type: 'csv', required: true, file: { name: '客户清单.csv', path: 'references/客户清单.csv' } },
			{ name: 'input_1', label: '备注', type: 'string' },
		]
		const result = validate.validateReferences(objects, {}, { artifactsDir })
		assert.equal(result.ok, true, JSON.stringify(result.issues))
		const injected = result.values['file_1']
		assert.ok(injected.startsWith(artifactsDir), `应落在工件根内：${injected}`)
		assert.ok(injected.includes(join('references', '')), '应落在 references/ 子目录内')
		assert.ok(injected.endsWith('客户清单.csv'))
		assert.ok(!injected.includes('..'), '不得含穿越段')
		assert.equal(result.injectedEmpty.includes('file_1'), false, '有附件的对象不算空串注入')
	})

	test('10.5 附件路径越界 → 具名违规（附件）；无工件根时不解析', () => {
		const objects = [
			{ name: 'file_1', label: '附件', type: 'file', file: { name: 'evil', path: 'references/../../escape.txt' } },
		]
		const result = validate.validateReferences(objects, {}, { artifactsDir: join(tempDir, 'artifacts-x') })
		assert.equal(result.ok, false)
		const issue = result.issues.find((item) => item.rule === 'file')
		assert.ok(issue, '必须有 file 规则违规')
		assert.equal(issue.ruleLabel, '附件')
		assert.equal(result.values['file_1'], '')
		const dryRun = validate.validateReferences(objects, {})
		assert.equal(dryRun.values['file_1'], '', '未提供工件根时不解析路径')
	})
})
