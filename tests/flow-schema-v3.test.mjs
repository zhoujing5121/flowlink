/**
 * Flow schema v3（Reference 正式化）永久回归测试（openspec change: formalize-reference）。
 *
 * 覆盖：v2→v3 类型映射（text/email/number）、label 启发式回填、v1/v2 旧 Flow 升级后
 * 步骤与模板键逐字节不变、未声明字段剥离、新字段往返、referenceFiles 路径防逃逸、
 * label 重复与表达式静态校验在契约层拒绝、未来版本拒绝。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let flowIO

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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-flow-schema-v3-'))
	flowIO = await bundle('engine/schema/src/io.ts', 'flow-io')
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function elementRef(overrides = {}) {
	return {
		observed: {
			tag: 'input',
			attributes: { type: 'text', name: 'cust', placeholder: '客户名称' },
			rect: { x: 0, y: 0, width: 120, height: 24 },
			viewport: { width: 1280, height: 800 },
			recordedAt: 1700000000000,
			...overrides.observed,
		},
		candidates: [{ kind: 'css', value: '#cust', score: 1 }],
		fingerprint: { tag: 'input', attrs: { name: 'cust' }, stableHash: 'h1' },
		...overrides,
	}
}

function baseFlow(overrides = {}) {
	return {
		schemaVersion: 2,
		id: 'flow_test',
		title: '测试流程',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		meta: {
			env: { startUrl: 'https://example.local/', viewport: { width: 1280, height: 800 } },
			recorder: { name: 'rr', version: '0.1.0' },
		},
		variables: [],
		steps: [{ kind: 'navigate', id: 's1', url: '{{url_1}}' }],
		...overrides,
	}
}

describe('v2 → v3 类型映射', () => {
	test('email → string + email 格式预设，默认值与模板引用不变', () => {
		const raw = baseFlow({
			variables: [{ name: 'input_1', type: 'email', defaultValue: 'a@b.co', secret: false, source: 'input' }],
			steps: [
				{ kind: 'navigate', id: 's1', url: '{{url_1}}' },
				{ kind: 'input', id: 's2', target: elementRef(), value: '{{input_1}}', clear: true },
			],
		})
		const before = JSON.stringify(raw.steps)
		const flow = flowIO.parseFlow(raw, '<v2-email>')
		// 迁移本身不改写步骤（parseFlow 的 Zod 归一化会补默认值，故用 migrateFlow 原始输出比对）
		assert.equal(JSON.stringify(flowIO.migrateFlow(raw).steps), before, '迁移不改写步骤（逐字节）')
		assert.equal(flow.schemaVersion, 3)
		const variable = flow.variables.find((item) => item.name === 'input_1')
		assert.equal(variable.type, 'string')
		assert.equal(variable.validation?.format?.preset, 'email', 'email 迁移必须附带格式预设')
		assert.equal(variable.defaultValue, 'a@b.co')
		assert.equal(flow.steps[1].value, '{{input_1}}')
		assert.equal(JSON.stringify(flow.steps[1].value), '"{{input_1}}"', '模板引用不变')
	})

	test('number 按默认值小数点判 integer/decimal；text → string', () => {
		const raw = baseFlow({
			variables: [
				{ name: 'input_1', type: 'number', defaultValue: '3', secret: false, source: 'input' },
				{ name: 'input_2', type: 'number', defaultValue: '3.5', secret: false, source: 'input' },
				{ name: 'input_3', type: 'text', defaultValue: '备注', secret: false, source: 'input' },
				{ name: 'input_4', type: 'number', secret: false, source: 'input' },
			],
		})
		const flow = flowIO.parseFlow(raw)
		const byType = Object.fromEntries(flow.variables.map((item) => [item.name, item.type]))
		assert.deepEqual(byType, {
			input_1: 'integer',
			input_2: 'decimal',
			input_3: 'string',
			input_4: 'integer',
		})
	})

	test('secret 与 type 互为镜像', () => {
		const raw = baseFlow({
			variables: [{ name: 'password', type: 'secret', secret: true, source: 'input' }],
		})
		const flow = flowIO.parseFlow(raw)
		const password = flow.variables.find((item) => item.name === 'password')
		assert.equal(password.type, 'secret')
		assert.equal(password.secret, true)
	})

	test('label 回填：成对日期 -开始/-结束，业务化兜底，机器键不动', () => {
		const dateTarget = (label) =>
			elementRef({
				observed: { tag: 'input', attributes: { type: 'date' }, rect: { x: 0, y: 0, width: 120, height: 24 }, viewport: { width: 1280, height: 800 }, recordedAt: 1700000000000 },
				candidates: [{ kind: 'label', value: label, score: 1 }],
				fingerprint: { tag: 'input', attrs: {}, stableHash: 'h' },
			})
		const raw = baseFlow({
			variables: [
				{ name: 'url_1', type: 'string', defaultValue: 'https://example.local/a', secret: false, source: 'input' },
				{ name: 'input_1', type: 'string', defaultValue: '2026-01-01', secret: false, source: 'input' },
				{ name: 'input_2', type: 'string', defaultValue: '2026-01-31', secret: false, source: 'input' },
			],
			steps: [
				{ kind: 'navigate', id: 's1', url: '{{url_1}}' },
				{ kind: 'input', id: 's2', target: dateTarget('创建日期'), value: '{{input_1}}', clear: true },
				{ kind: 'input', id: 's3', target: dateTarget('创建日期'), value: '{{input_2}}', clear: true },
			],
		})
		const flow = flowIO.parseFlow(raw)
		const labels = Object.fromEntries(flow.variables.map((item) => [item.name, item.label]))
		assert.equal(labels['input_1'], '创建日期-开始')
		assert.equal(labels['input_2'], '创建日期-结束')
		assert.equal(labels['url_1'], '网址', 'url 变量按类型语义兜底为业务名')
		for (const variable of flow.variables) {
			assert.ok(variable.label && !/^(input|url|select|file)_\d+$/.test(variable.label), 'label 不得是机器键风格')
		}
		// 机器键与模板引用不动
		assert.equal(flow.variables[0].name, 'url_1')
		assert.equal(flow.steps[0].url, '{{url_1}}')
	})
})

describe('v1/v2 兼容与版本拒绝', () => {
	test('v1 录制迁移为 v3，步骤序列不变', () => {
		const raw = baseFlow({ schemaVersion: 1 })
		delete raw.referenceFiles
		const before = JSON.stringify(raw.steps)
		const migrated = flowIO.migrateFlow(raw)
		assert.equal(JSON.stringify(migrated.steps), before, '迁移不改写步骤（逐字节）')
		assert.equal(migrated.schemaVersion, 3)
		const flow = flowIO.parseFlow(raw)
		assert.equal(flow.schemaVersion, 3)
		assert.equal(flow.steps[0].url, '{{url_1}}')
	})

	test('v0（无 schemaVersion）补默认字段并升到 v3', () => {
		const raw = baseFlow()
		delete raw.schemaVersion
		delete raw.version
		const flow = flowIO.parseFlow(raw)
		assert.equal(flow.schemaVersion, 3)
		assert.equal(flow.version, 1)
	})

	test('高于当前版本拒绝', () => {
		const raw = baseFlow({ schemaVersion: 99 })
		assert.throws(() => flowIO.parseFlow(raw), /高于当前支持/)
	})
})

describe('新字段契约', () => {
	test('未声明字段剥离，新字段往返', () => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.variables = [
			{
				name: 'input_1',
				label: '客户名称',
				type: 'string',
				defaultValue: 'abc',
				secret: false,
				required: true,
				validation: {
					caseMode: 'upper',
					format: { preset: 'email' },
					sign: 'positive',
					condition: '客户名称 != ""',
					formula: '',
				},
				activities: ['g1', 'g2'],
				source: 'input',
				hackerField: 'should-be-stripped',
			},
		]
		flow.referenceFiles = [
			{ id: 'rf_1', name: '附件.docx', type: 'word', path: 'references/附件.docx' },
		]
		const reparsed = flowIO.parseFlow(JSON.parse(flowIO.serializeFlow(flow)))
		// 经 serialize→parse 往返（zod strip 未声明字段）
		const variable = reparsed.variables[0]
		assert.equal(variable.label, '客户名称')
		assert.equal(variable.required, true)
		assert.equal(variable.validation.caseMode, 'upper')
		assert.equal(variable.validation.format.preset, 'email')
		assert.deepEqual(variable.activities, ['g1', 'g2'])
		assert.equal(variable.hackerField, undefined, '未声明字段被剥离')
		assert.equal(reparsed.referenceFiles[0].name, '附件.docx')
		assert.equal(reparsed.referenceFiles[0].hackerField, undefined)
	})

	test('referenceFiles 路径逃逸拒绝', () => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.referenceFiles = [{ id: 'rf_1', name: 'evil', type: 'file', path: 'references/../../escape.txt' }]
		assert.throws(() => flowIO.parseFlow(flow), /path/)
		flow.referenceFiles = [{ id: 'rf_1', name: 'evil', type: 'file', path: 'outside/evil.txt' }]
		assert.throws(() => flowIO.parseFlow(flow), /path/)
	})

	test('label 重复在契约层拒绝', () => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.variables = [
			{ name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input' },
			{ name: 'input_2', label: '客户名称', type: 'string', secret: false, source: 'input' },
		]
		assert.throws(() => flowIO.parseFlow(flow), /label "客户名称" 重复/)
	})

	test('非法公式表达式在契约层拒绝（保存关口）', () => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.variables = [
			{ name: 'input_1', label: '合计', type: 'integer', secret: false, source: 'input', validation: { formula: '单价 +' } },
		]
		assert.throws(() => flowIO.parseFlow(flow, '<save>', { strict: true }), /表达式错误/)
	})

	test('公式循环引用在契约层拒绝', () => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.variables = [
			{ name: 'a', label: '甲', type: 'integer', secret: false, source: 'input', validation: { formula: '乙 + 1' } },
			{ name: 'b', label: '乙', type: 'integer', secret: false, source: 'input', validation: { formula: '甲 + 1' } },
		]
		assert.throws(() => flowIO.parseFlow(flow), /循环引用/)
	})
})

describe('10.2 VariableSchema.file 附件字段', () => {
	const withFileVariable = (variable) => {
		const flow = flowIO.parseFlow(baseFlow())
		flow.variables = [variable]
		return flow
	}

	test('字段往返：文件类对象携带附件，serialize → parse 后保持', () => {
		const flow = withFileVariable({
			name: 'file_1', label: '客户清单', type: 'csv', secret: false, source: 'input',
			file: { name: '客户清单.csv', path: 'references/客户清单.csv' },
		})
		const reparsed = flowIO.parseFlow(JSON.parse(flowIO.serializeFlow(flow)))
		assert.deepEqual(reparsed.variables[0].file, { name: '客户清单.csv', path: 'references/客户清单.csv' })
		// 五种文件类类型都可携带
		for (const type of ['excel', 'word', 'csv', 'md', 'file']) {
			const parsed = flowIO.parseFlow({
				...baseFlow(),
				variables: [{ name: 'file_1', label: '附件', type, secret: false, source: 'input', file: { name: 'a.bin', path: 'references/a.bin' } }],
			})
			assert.equal(parsed.variables[0].file.path, 'references/a.bin')
		}
	})

	test('路径逃逸拒绝', () => {
		const flow = withFileVariable({
			name: 'file_1', label: '附件', type: 'file', secret: false, source: 'input',
			file: { name: 'evil', path: 'references/../../escape.txt' },
		})
		assert.throws(() => flowIO.parseFlow(flow), /附件 path/)
		const outside = withFileVariable({
			name: 'file_1', label: '附件', type: 'file', secret: false, source: 'input',
			file: { name: 'evil', path: 'outside/evil.txt' },
		})
		assert.throws(() => flowIO.parseFlow(outside), /附件 path/)
	})

	test('非文件类对象携带附件被拒绝', () => {
		const flow = withFileVariable({
			name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input',
			file: { name: 'a.txt', path: 'references/a.txt' },
		})
		assert.throws(() => flowIO.parseFlow(flow), /只有文件类对象/)
	})

	test('无附件字段的旧数据天然兼容', () => {
		const flow = flowIO.parseFlow(baseFlow({
			variables: [
				{ name: 'file_1', type: 'file', secret: false, source: 'input' },
				{ name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input' },
			],
		}))
		assert.equal(flow.variables[0].file, undefined)
		assert.equal(flow.variables[1].file, undefined)
		// 迁移不凭空造出附件字段
		const migrated = flowIO.migrateFlow(baseFlow({ variables: [{ name: 'file_1', type: 'file', secret: false, source: 'input' }] }))
		assert.equal('file' in migrated.variables[0], false)
	})
})
