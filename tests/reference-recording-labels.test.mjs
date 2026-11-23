/**
 * 录制端变量业务命名（label）永久回归测试（openspec change: formalize-reference）。
 *
 * record.ts 的五个变量抽取点（url_N/input_N/select_N/file_N/password）在创建变量的同时
 * 记录命名种子，录制收尾 applyRecordingLabels 统一生成 label。此处覆盖纯函数行为
 * 与 Flow 持久化契约；端到端录制行为由 7.4 真机验证覆盖。
 *
 * record.ts 传递依赖 playwright-core（运行时 require chromium-bidi），不能 esbuild 打包，
 * 走 tsx 直接导入（同 tests/pi-knowledge.test.ts 风格）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { applyRecordingLabels } from '../engine/recorder/src/record.js'
import { parseFlow } from '../engine/schema/src/io.js'

/** 模拟录制端五个抽取点产出的变量与种子（与 record.ts 同构） */
function recordedSet() {
	const variables = [
		{ name: 'url_1', type: 'url', defaultValue: 'https://example.local/a', secret: false, source: 'input' },
		{ name: 'password', type: 'secret', secret: true, source: 'input' },
		{ name: 'input_1', type: 'string', defaultValue: '2026-01-01', secret: false, source: 'input' },
		{ name: 'input_2', type: 'string', defaultValue: '2026-01-31', secret: false, source: 'input' },
		{ name: 'input_3', type: 'string', defaultValue: '客户A', secret: false, source: 'input' },
		{ name: 'select_1', type: 'string', defaultValue: 'urgent', secret: false, source: 'input' },
		{ name: 'file_1', type: 'file', secret: false, source: 'input' },
	]
	const seeds = [
		{ key: 'url_1', evidence: { pageIndex: 0 }, kindHint: 'url' },
		{ key: 'password', evidence: { inputType: 'password', pageIndex: 0 }, kindHint: 'password' },
		{ key: 'input_1', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 }, kindHint: 'input' },
		{ key: 'input_2', evidence: { labelText: '创建日期', inputType: 'date', pageIndex: 0 }, kindHint: 'input' },
		{ key: 'input_3', evidence: { placeholder: '客户名称', inputType: 'text', pageIndex: 0 }, kindHint: 'input' },
		{ key: 'select_1', evidence: { labelText: '优先级', pageIndex: 0 }, kindHint: 'select' },
		{ key: 'file_1', evidence: { inputType: 'file', pageIndex: 0 }, kindHint: 'upload' },
	]
	return { variables, seeds }
}

describe('3.1 录制端 label', () => {
	test('新变量携带非机器风格 label，机器键与模板语义不变', () => {
		const { variables, seeds } = recordedSet()
		const labeled = applyRecordingLabels(variables, seeds)
		const byName = Object.fromEntries(labeled.map((variable) => [variable.name, variable]))
		assert.equal(byName['url_1'].label, '网址')
		assert.equal(byName['password'].label, '密码')
		assert.equal(byName['input_1'].label, '创建日期-开始', '同页成对日期加区间后缀')
		assert.equal(byName['input_2'].label, '创建日期-结束')
		assert.equal(byName['input_3'].label, '客户名称')
		assert.equal(byName['select_1'].label, '优先级')
		assert.equal(byName['file_1'].label, '文件')
		for (const variable of labeled) {
			assert.ok(variable.label, '每个录制变量都必须有 label')
			assert.ok(!/^(input|url|select|file)_\d+$/.test(variable.label), 'label 不得是机器键风格')
			assert.match(variable.name, /^(url|input|select|file)_\d+$|^password$/, '机器键保持 ASCII 命名')
		}
		// 持久化契约：模板值仍是 {{原机器键}}，label 随 Flow 落盘
		const flow = parseFlow({
			schemaVersion: 3,
			id: 'flow_test',
			title: 't',
			version: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			meta: {
				env: { startUrl: 'https://example.local/', viewport: { width: 1280, height: 800 } },
				recorder: { name: 'rr', version: '0.1.0' },
			},
			variables: labeled,
			referenceFiles: [],
			steps: [
				{ kind: 'navigate', id: 's1', url: '{{url_1}}' },
				{
					kind: 'input', id: 's2', value: '{{input_1}}', clear: true, target: {
						observed: { tag: 'input', attributes: { type: 'text' }, rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 1280, height: 800 }, recordedAt: 1 },
						candidates: [{ kind: 'css', value: '#a', score: 1 }],
						fingerprint: { tag: 'input', attrs: {}, stableHash: 'h' },
					},
				},
				{
					kind: 'input', id: 's3', value: '{{password}}', clear: true, target: {
						observed: { tag: 'input', attributes: { type: 'password' }, rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 1280, height: 800 }, recordedAt: 1 },
						candidates: [{ kind: 'css', value: '#p', score: 1 }],
						fingerprint: { tag: 'input', attrs: {}, stableHash: 'h' },
					},
				},
			],
			selfHealed: [],
		})
		assert.equal(flow.steps[0].url, '{{url_1}}', '模板值仍是 {{原机器键}}')
		assert.equal(flow.steps[1].value, '{{input_1}}')
		assert.equal(flow.steps[2].value, '{{password}}')
		assert.equal(flow.variables.find((variable) => variable.name === 'input_1').label, '创建日期-开始')
	})

	test('无种子的变量保持原样（防御）', () => {
		const { variables } = recordedSet()
		const labeled = applyRecordingLabels(variables, [])
		assert.equal(labeled.find((variable) => variable.name === 'url_1').label, undefined)
		assert.equal(labeled.length, variables.length)
	})
})
