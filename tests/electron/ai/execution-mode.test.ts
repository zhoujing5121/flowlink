/**
 * 执行方式（execution: automated|manual）归一守卫永久回归测试。
 *
 * 覆盖：动作步骤缺失/非法回落 manual（保守默认）、大小写容错、自带执行语义的
 * 步骤类型强制清除、嵌套组递归、executionDecisions sidecar 的字段校验/置信度
 * 钳制/失配降级并入 risks。背景：录制与手动添加默认 manual，Refine 由 AI 逐步
 * 判定，归一不依赖模型自觉。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizeExecutionModes, type ExecutionDecision } from '../../../electron/ai/ai-refine.js'
import type { Step } from '../../../engine/schema/src/index.js'

const step = (id: string, kind: string, extra: Record<string, unknown> = {}): Step =>
	({ id, kind, ...extra }) as unknown as Step

describe('normalizeExecutionModes：步骤字段归一', () => {
	test('动作步骤缺失 execution → 回落 manual，缺失聚合为单条 risk', () => {
		const steps = [step('s1', 'click', { label: '提交' }), step('s2', 'input')]
		const { decisions, risks } = normalizeExecutionModes(steps, undefined)
		assert.equal((steps[0] as { execution?: string }).execution, 'manual')
		assert.equal((steps[1] as { execution?: string }).execution, 'manual')
		assert.equal(decisions.length, 0)
		assert.equal(risks.length, 1)
		assert.match(risks[0]!, /2 个步骤未输出执行方式/)
		assert.match(risks[0]!, /提交/)
	})

	test('大小写容错：Manual/Automated 归一为小写且不产生 risk', () => {
		const steps = [
			step('s1', 'click', { execution: 'Manual' }),
			step('s2', 'input', { execution: 'AUTOMATED' }),
		]
		const { risks } = normalizeExecutionModes(steps, undefined)
		assert.equal((steps[0] as { execution?: string }).execution, 'manual')
		assert.equal((steps[1] as { execution?: string }).execution, 'automated')
		assert.deepEqual(risks, [])
	})

	test('非法值 → 回落 manual 并逐条 risk', () => {
		const steps = [step('s1', 'click', { execution: 'semi-auto' })]
		const { risks } = normalizeExecutionModes(steps, undefined)
		assert.equal((steps[0] as { execution?: string }).execution, 'manual')
		assert.equal(risks.length, 1)
		assert.match(risks[0]!, /非法/)
	})

	test('自带执行语义的类型强制清除 execution（manual 分支会抢先于原生处理）', () => {
		const kinds = ['wait', 'assert', 'condition', 'dialog', 'script']
		const steps = kinds.map((kind, index) => step(`s${index + 1}`, kind, { execution: 'manual' }))
		const { risks } = normalizeExecutionModes(steps, undefined)
		for (const stepItem of steps) {
			assert.equal((stepItem as { execution?: string }).execution, undefined, `${stepItem.kind} 应清除 execution`)
		}
		assert.deepEqual(risks, [])
	})

	test('嵌套组递归：L2 组内子步骤同样归一', () => {
		const child = step('s1', 'click')
		const steps = [
			{
				id: 'g1',
				kind: 'group',
				label: '组',
				steps: [{ id: 'g2', kind: 'group', label: '子组', steps: [child] }],
			},
		] as unknown as Step[]
		normalizeExecutionModes(steps, undefined)
		assert.equal((child as { execution?: string }).execution, 'manual')
	})
})

describe('normalizeExecutionModes：executionDecisions sidecar', () => {
	const steps = () => [step('s1', 'click', { label: '提交', execution: 'manual' })]

	test('合法条目保留，confidence 钳制到 [0,1]，数组字段过滤非字符串', () => {
		const decisions = [
			{
				stepId: 's1',
				execution: 'manual',
				reason: '需要审批',
				confidence: 2,
				requiredCapabilities: ['审批通道', 42],
				unresolvedQuestions: ['金额上限？', null],
			},
		]
		const { decisions: out, risks } = normalizeExecutionModes(steps(), decisions)
		assert.deepEqual(risks, [])
		const only = out[0] as ExecutionDecision & { confidence?: number }
		assert.equal(only.stepId, 's1')
		assert.equal(only.execution, 'manual')
		assert.equal(only.reason, '需要审批')
		assert.equal(only.confidence, 1)
		assert.deepEqual(only.requiredCapabilities, ['审批通道'])
		assert.deepEqual(only.unresolvedQuestions, ['金额上限？'])
	})

	test('失配/残缺条目降级并入 risks，理由不丢', () => {
		const decisions = [
			{ stepId: 'ghost', execution: 'manual', reason: '外部系统无法定位' },
			{ stepId: 's1', execution: 'maybe', reason: '随便' },
			{ stepId: 's1', execution: 'automated' },
		]
		const { decisions: out, risks } = normalizeExecutionModes(steps(), decisions)
		assert.equal(out.length, 0)
		assert.equal(risks.length, 3)
		assert.match(risks[0]!, /stepId=ghost/)
		assert.match(risks[0]!, /外部系统无法定位/)
		assert.match(risks[2]!, /reason 缺失|无法匹配/)
	})

	test('sidecar 缺失或非数组 → 无 decisions 无 risks', () => {
		for (const value of [undefined, 'nope', {}]) {
			const { decisions, risks } = normalizeExecutionModes(steps(), value)
			assert.equal(decisions.length, 0)
			assert.deepEqual(risks, [])
		}
	})
})
