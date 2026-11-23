/**
 * AI refine 命名契约永久回归测试（openspec change: formalize-reference）。
 *
 * 覆盖：mergeVariables 的 variableLabels 合并（非空 label 覆盖、未知机器键整次拒绝、
 * 其余 Reference 元数据按源保留）、提示词模板占位符完整性（机器键不可变条款 +
 * variableLabels 输出契约）。
 */
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let aiRefine
let promptsModule
let templates

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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-ai-labels-'))
	;[aiRefine, promptsModule] = await Promise.all([
		bundle('src/ai-refine.ts', 'ai-refine'),
		bundle('src/prompts.ts', 'prompts'),
	])
	templates = JSON.parse(await readFile(join(process.cwd(), 'config', 'prompts.json'), 'utf8'))
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function sourceFlow(variables) {
	return {
		schemaVersion: 3,
		id: 'flow_src',
		title: '源流程',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		meta: {
			env: { startUrl: 'https://example.local/', viewport: { width: 1280, height: 800 } },
			recorder: { name: 'rr', version: '0.1.0' },
		},
		variables,
		referenceFiles: [],
		steps: [{ kind: 'navigate', id: 's1', url: '{{url_1}}' }],
		selfHealed: [],
	}
}

describe('5.1 mergeVariables 支持 variableLabels', () => {
	test('非空 label 覆盖启发式/旧值，机器键与模板语义不变', () => {
		const source = sourceFlow([
			{ name: 'input_2', label: '文本输入', type: 'string', defaultValue: 'x', secret: false, source: 'input' },
			{ name: 'url_1', label: '地址', type: 'url', defaultValue: 'https://a', secret: false, source: 'input' },
		])
		const merged = aiRefine.mergeVariables([source], undefined, [
			{ name: 'input_2', label: '客户编码' },
			{ name: 'url_1', label: '系统入口' },
		])
		const byName = Object.fromEntries(merged.map((variable) => [variable.name, variable]))
		assert.equal(byName['input_2'].label, '客户编码', '模型非空 label 覆盖')
		assert.equal(byName['url_1'].label, '系统入口')
		assert.equal(byName['input_2'].name, 'input_2', '机器键不变')
		assert.equal(byName['input_2'].defaultValue, 'x')
	})

	test('空/空白 label 不覆盖', () => {
		const source = sourceFlow([
			{ name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input' },
		])
		const merged = aiRefine.mergeVariables([source], undefined, [
			{ name: 'input_1', label: '' },
			{ name: 'input_1', label: '   ' },
		])
		assert.equal(merged[0].label, '客户名称')
	})

	test('未知机器键整次拒绝（与现有未知变量同一报错面）', () => {
		const source = sourceFlow([
			{ name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input' },
		])
		assert.throws(
			() => aiRefine.mergeVariables([source], undefined, [{ name: 'ghost', label: '幽灵' }]),
			/不存在的变量 \{\{ghost\}\}/,
		)
		assert.throws(
			() => aiRefine.mergeVariables([source], undefined, 'not-an-array'),
			/variableLabels 必须是/,
		)
	})

	test('其余 Reference 元数据按源保留（必填/校验/活动不来自模型）', () => {
		const source = sourceFlow([
			{
				name: 'input_1',
				label: '客户名称',
				type: 'integer',
				secret: false,
				required: true,
				validation: { sign: 'positive' },
				activities: ['g1'],
				source: 'input',
			},
		])
		const merged = aiRefine.mergeVariables([source], undefined, [{ name: 'input_1', label: '订单数量' }])
		const variable = merged[0]
		assert.equal(variable.label, '订单数量')
		assert.equal(variable.required, true)
		assert.deepEqual(variable.validation, { sign: 'positive' })
		assert.deepEqual(variable.activities, ['g1'])
	})

	test('Pi 提议的旧类型变量归一到新目录', () => {
		const source = sourceFlow([])
		const merged = aiRefine.mergeVariables([source], [
			{ name: 'input_1', type: 'email', defaultValue: 'a@b.co' },
			{ name: 'input_2', type: 'number', defaultValue: '3.5' },
		])
		const byName = Object.fromEntries(merged.map((variable) => [variable.name, variable]))
		assert.equal(byName['input_1'].type, 'string')
		assert.equal(byName['input_2'].type, 'decimal')
	})
})

describe('8.4 活动关联默认值', () => {
	const groupedSteps = [
		{
			kind: 'group', id: 'g1', label: '填写订单', steps: [
				{ kind: 'navigate', id: 's1', url: '{{url_1}}' },
				{ kind: 'input', id: 's2', value: '{{input_1}}', clear: true },
			],
		},
		{
			kind: 'group', id: 'g2', label: '提交订单', steps: [
				{ kind: 'group', id: 'g2a', label: '确认', steps: [
					{ kind: 'input', id: 's3', value: '{{input_1}}', clear: true },
				] },
				{ kind: 'click', id: 's4' },
			],
		},
	]

	test('parseVariableActivities：未知机器键整次拒绝、形状非法拒绝', () => {
		const known = new Set(['input_1'])
		assert.throws(
			() => aiRefine.parseVariableActivities([{ name: 'ghost', activities: ['g1'] }], known),
			/不存在的变量 \{\{ghost\}\}/,
		)
		assert.throws(() => aiRefine.parseVariableActivities('nope', known), /variableActivities 必须是/)
		assert.throws(
			() => aiRefine.parseVariableActivities([{ name: 'input_1', activities: 'g1' }], known),
			/activities 必须是非空字符串数组/,
		)
		assert.equal(aiRefine.parseVariableActivities(undefined, known).size, 0)
		// 未知分组 id 不在此拒（留待按新材料分组剔除）
		assert.deepEqual(
			[...aiRefine.parseVariableActivities([{ name: 'input_1', activities: ['nope-group'] }], known).entries()],
			[['input_1', ['nope-group']]],
		)
	})

	test('使用证据推导：多处分组即多选，组内递归', () => {
		const variables = [
			{ name: 'url_1', type: 'url', secret: false, source: 'input' },
			{ name: 'input_1', type: 'string', secret: false, source: 'input' },
			{ name: 'input_2', type: 'string', secret: false, source: 'input' },
		]
		const evidence = aiRefine.deriveVariableActivities(variables, groupedSteps)
		assert.deepEqual(evidence.get('url_1'), ['g1'])
		assert.deepEqual(evidence.get('input_1'), ['g1', 'g2'], '两个 L1 分组都用到 → 多选')
		assert.equal(evidence.get('input_2'), undefined, '未被引用 → 无证据')
	})

	test('applyActivityDefaults：清除源继承悬空 id、证据优先、建议补空、未知分组剔除', () => {
		const variables = [
			{ name: 'url_1', type: 'url', secret: false, source: 'input', activities: ['stale-from-source'] },
			{ name: 'input_2', type: 'string', secret: false, source: 'input', activities: ['stale-too'] },
			{ name: 'input_3', type: 'string', secret: false, source: 'input' },
		]
		const suggestions = new Map([
			['input_2', ['g2']],
			['input_3', ['g2', 'ghost-group']],
		])
		const applied = aiRefine.applyActivityDefaults(variables, groupedSteps, suggestions)
		const byName = Object.fromEntries(applied.map((variable) => [variable.name, variable]))
		assert.deepEqual(byName['url_1'].activities, ['g1'], '证据覆盖源继承的悬空 id')
		assert.deepEqual(byName['input_2'].activities, ['g2'], '无证据 → 建议填充')
		assert.deepEqual(byName['input_3'].activities, ['g2'], '建议中的未知分组 id 被剔除不拒')
	})
})

describe('8.4 提示词 variableActivities 指引', () => {
	test('systemPrompt 与 generation 模板包含 variableActivities 输出契约', () => {
		assert.ok(templates.systemPrompt.includes('variableActivities'))
		assert.ok(templates.generation.autoSanitize.includes('variableActivities'))
		assert.ok(templates.generation.refine.includes('variableActivities'))
		assert.ok(templates.systemPrompt.includes('usage evidence wins over suggestions'))
	})
})

describe('5.2 提示词模板契约', () => {
	const KNOWN_KEYS = new Set(['metadata', 'library', 'steps', 'stepSections', 'conversation', 'instruction', 'flowCount'])

	test('systemPrompt：机器键不可变 + variableLabels 输出契约', () => {
		const s = templates.systemPrompt
		assert.ok(s.includes('variableLabels'))
		assert.ok(s.includes('Machine keys are immutable'))
		assert.ok(s.includes('-开始 / -结束'))
		assert.ok(!s.includes('never rename a variable'), '旧「禁止改名」条款应已改写')
	})

	test('generation 模板：variableLabels 在返回契约中，占位符完整且无未知占位符', () => {
		for (const key of ['autoSanitize', 'refine']) {
			const template = templates.generation[key]
			assert.ok(template.includes('variableLabels'), `${key} 必须声明 variableLabels 输出`)
			assert.ok(template.includes('immutable'), `${key} 必须声明机器键不可变`)
			assert.ok(template.includes('-开始'), `${key} 必须声明成对区间后缀`)
			const placeholders = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
			for (const name of placeholders) {
				assert.ok(KNOWN_KEYS.has(name), `${key} 出现未知占位符 {{${name}}}`)
			}
		}
		assert.ok(templates.generation.autoSanitize.includes('{{metadata}}'))
		assert.ok(templates.generation.autoSanitize.includes('{{library}}'))
		assert.ok(templates.generation.autoSanitize.includes('{{steps}}'))
		assert.ok(templates.generation.refine.includes('{{stepSections}}'))
	})

	test('formatTemplate 可完整填充（缺失值会显式抛错，不被示例模板干扰）', () => {
		const autoSanitize = promptsModule.formatTemplate(templates.generation.autoSanitize, {
			metadata: 'm',
			library: 'l',
			steps: 's',
		})
		assert.ok(autoSanitize.includes('variableLabels'))
		assert.ok(autoSanitize.includes('{{ input_1 }}'), '示例模板保持字面量')
		const refine = promptsModule.formatTemplate(templates.generation.refine, {
			flowCount: '1',
			instruction: 'i',
			conversation: 'c',
			metadata: 'm',
			library: 'l',
			stepSections: 's',
		})
		assert.ok(refine.includes('variableLabels'))
	})
})
