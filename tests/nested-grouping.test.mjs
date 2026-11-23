import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

// add-multilevel-grouping 永久回归：
// 1.1 schema 契约（嵌套落盘 / id 全命名空间唯一 / 空组拒绝 / targetSystem 持久化）
// 1.2 执行器数据边界（零行为改动：flattenSteps 前缀 / 最外层组 / 分支目标解析域）
// 2.1 numberingOf 层级编号派生
// 3.1 生成输出嵌套契约 + prompts 模板纪律

let tempDir
let flowIO
let executorSteps
let FlowGraph
let aiRefine
let promptGenerationTemplates

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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-nested-grouping-'))
	flowIO = await bundle('engine/schema/src/io.ts', 'flow-io')
	executorSteps = await bundle('engine/executor/src/steps.ts', 'executor-steps')
	aiRefine = await bundle('src/ai-refine.ts', 'ai-refine')
	promptGenerationTemplates = JSON.parse(
		await readFile(join(process.cwd(), 'config', 'prompts.json'), 'utf8'),
	).generation
	// flow-graph.js 是 window 全局脚本：垫片后再加载，取 window.FlowGraph。
	globalThis.window = globalThis
	await bundle('renderer/flow-graph.js', 'flow-graph')
	FlowGraph = globalThis.window.FlowGraph
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function elementRef(type = 'text') {
	return {
		observed: {
			tag: 'input',
			attributes: { type },
			rect: { x: 0, y: 0, width: 120, height: 24 },
			viewport: { width: 800, height: 600 },
			recordedAt: 1,
		},
		candidates: [{ kind: 'css', value: '#target', score: 0 }],
		fingerprint: { tag: 'input', stableHash: 'target' },
	}
}

function flow(steps, schemaVersion = 2) {
	return {
		schemaVersion,
		id: 'flow-nested',
		title: 'Nested flow',
		createdAt: '2025-01-01T00:00:00.000Z',
		meta: {
			env: { startUrl: 'https://example.test', viewport: { width: 800, height: 600 } },
			recorder: { name: 'test', version: '1' },
		},
		steps,
	}
}

const waitStep = (id) => ({ kind: 'wait', id, condition: 'timeout', ms: 10 })

/** L1(业务级) > L2(技术级) > L3 步骤 的标准嵌套样本。 */
function nestedFlowSteps() {
	return [
		{
			kind: 'group',
			id: 'stage-apply',
			label: '提交申请',
			targetSystem: 'CRM',
			steps: [
				{
					kind: 'group',
					id: 'fill-form',
					label: '填写表单',
					targetSystem: 'CRM Web',
					steps: [
						{ kind: 'click', id: 'open-form', target: elementRef() },
						{ kind: 'input', id: 'fill-name', target: elementRef(), value: '{{name}}' },
					],
				},
				waitStep('submit'),
			],
		},
		{
			kind: 'group',
			id: 'stage-notify',
			label: '发送通知',
			steps: [waitStep('notify')],
		},
	]
}

/* ---------------- 1.1 schema 契约 ---------------- */

test('nested L1/L2 flow saves and reloads with hierarchy and targetSystem intact', async () => {
	const { saveFlow, loadFlow } = flowIO
	const file = join(tempDir, 'nested.flow.json')
	await saveFlow(flow(nestedFlowSteps()), file)
	const loaded = await loadFlow(file)

	assert.equal(loaded.steps.length, 2)
	const l1 = loaded.steps[0]
	assert.equal(l1.kind, 'group')
	const l2 = l1.steps[0]
	assert.equal(l2.kind, 'group')
	assert.equal(l2.steps[0].id, 'open-form')
	// 嵌套原样持久化（加载后层级不变）
	assert.equal(l2.steps.length, 2)
	assert.equal(l1.steps[1].id, 'submit')
	// targetSystem 显式声明 → Zod 不剥离；任意层级可携带
	assert.equal(l1.targetSystem, 'CRM')
	assert.equal(l2.targetSystem, 'CRM Web')
	// 无标签为合法数据
	assert.equal(loaded.steps[1].targetSystem, undefined)
})

test('strict validation rejects duplicate ids across the whole flow namespace', () => {
	// 嵌套组内步骤 id 与其他步骤重复
	const dupStep = nestedFlowSteps()
	dupStep[1].steps.push({ kind: 'click', id: 'open-form', target: elementRef() })
	assert.throws(() => flowIO.parseFlow(flow(dupStep), '<strict>', { strict: true }), /重复/)

	// 组 id 与步骤 id 碰撞（共享命名空间）
	const dupGroup = nestedFlowSteps()
	dupGroup[0].steps[0].steps.push({
		kind: 'group',
		id: 'submit',
		label: '误用步骤 id 当组 id',
		steps: [waitStep('inner')],
	})
	assert.throws(() => flowIO.parseFlow(flow(dupGroup), '<strict>', { strict: true }), /重复/)

	// 顶层组重复
	const dupTop = nestedFlowSteps()
	dupTop.push({ kind: 'group', id: 'stage-apply', label: '重复顶层', steps: [waitStep('x')] })
	assert.throws(() => flowIO.parseFlow(flow(dupTop), '<strict>', { strict: true }), /重复/)

	// 宽松加载（旧数据容忍）：重复 id 不阻断读取，保存时才暴露
	assert.doesNotThrow(() => flowIO.parseFlow(flow(dupStep), '<load>'))
})

test('strict validation rejects empty groups; lenient load tolerates them', () => {
	const withEmpty = nestedFlowSteps()
	withEmpty[1].steps = []
	assert.throws(() => flowIO.parseFlow(flow(withEmpty), '<strict>', { strict: true }), /空分组/)
	// 嵌套空组同样拒绝
	const withEmptyNested = nestedFlowSteps()
	withEmptyNested[0].steps[0].steps = []
	assert.throws(
		() => flowIO.parseFlow(flow(withEmptyNested), '<strict>', { strict: true }),
		/空分组/,
	)
	assert.doesNotThrow(() => flowIO.parseFlow(flow(withEmpty), '<load>'))
})

test('legacy flat two-level flows stay valid without migration', () => {
	const flat = [
		{ kind: 'group', id: 'g1', label: '一', steps: [waitStep('a'), waitStep('b')] },
		{ kind: 'group', id: 'g2', label: '二', steps: [waitStep('c')] },
	]
	const parsed = flowIO.parseFlow(flow(flat))
	assert.equal(parsed.steps.length, 2)
	assert.equal(parsed.steps[0].steps.length, 2)
	assert.doesNotThrow(() => flowIO.parseFlow(flow(flat), '<strict>', { strict: true }))
})

test('accepts nesting deeper than three levels (unbounded depth)', async () => {
	const deep = [
		{
			kind: 'group',
			id: 'l1',
			label: 'L1',
			steps: [
				{
					kind: 'group',
					id: 'l2',
					label: 'L2',
					steps: [
						{
							kind: 'group',
							id: 'l3',
							label: 'L3',
							steps: [
								{
									kind: 'group',
									id: 'l4',
									label: 'L4',
									steps: [waitStep('deep-step')],
								},
							],
						},
					],
				},
			],
		},
	]
	const parsed = flowIO.parseFlow(flow(deep), '<strict>', { strict: true })
	const file = join(tempDir, 'deep.flow.json')
	await flowIO.saveFlow(parsed, file)
	const loaded = await flowIO.loadFlow(file)
	assert.equal(loaded.steps[0].steps[0].steps[0].steps[0].steps[0].id, 'deep-step')
})

test('condition branch targets resolve at any nesting depth', () => {
	const steps = [
		{
			kind: 'group',
			id: 'stage-a',
			label: 'A',
			steps: [
				{
					kind: 'group',
					id: 'tech-a',
					label: 'A.tech',
					steps: [
						{
							kind: 'condition',
							id: 'gate',
							target: elementRef(),
							assertion: { kind: 'visible' },
							trueStepId: 'far-target',
						},
					],
				},
			],
		},
		{
			kind: 'group',
			id: 'stage-b',
			label: 'B',
			steps: [
				{
					kind: 'group',
					id: 'tech-b',
					label: 'B.tech',
					steps: [waitStep('far-target')],
				},
			],
		},
	]
	assert.doesNotThrow(() => flowIO.parseFlow(flow(steps), '<strict>', { strict: true }))
	const missing = structuredClone(steps)
	missing[0].steps[0].steps[0].falseStepId = 'nowhere'
	assert.throws(() => flowIO.parseFlow(flow(missing), '<strict>', { strict: true }), /不存在的 step/)
})

/* ---------------- 1.2 执行器数据边界（engine/executor 代码零改动） ---------------- */

test('flattenSteps prefixes nested step ids and keeps index continuous', () => {
	const flat = executorSteps.flattenSteps(nestedFlowSteps())
	assert.deepEqual(
		flat.map((item) => item.stepId),
		['stage-apply/fill-form/open-form', 'stage-apply/fill-form/fill-name', 'stage-apply/submit', 'stage-notify/notify'],
	)
	assert.deepEqual(
		flat.map((item) => item.index),
		[0, 1, 2, 3],
	)
	assert.deepEqual(
		flat.map((item) => item.depth),
		[2, 2, 1, 1],
	)
})

test('loop limit keys on the outermost owning group (groupId of nested steps)', () => {
	// run.ts 的 FLOW_LOOP_LIMIT 按 flat[].groupId 计数（>3 次抛错）；嵌套步骤的
	// groupId 必须是最外层顶层组——锁定该数据契约即锁定「循环上限按最外层组」语义。
	const flat = executorSteps.flattenSteps(nestedFlowSteps())
	assert.deepEqual(
		flat.map((item) => item.groupId),
		['stage-apply', 'stage-apply', 'stage-apply', 'stage-notify'],
	)
})

test('branch targets fall inside the flat id resolution domain run.ts builds', () => {
	// run.ts 以 flat[].step.id（原始 id，首现去重）建 stepIndexById；分支目标必须
	// 落在该域内。收集全部 condition 目标并断言其存在于扁平域。
	const steps = nestedFlowSteps()
	steps[0].steps.splice(1, 0, {
		kind: 'condition',
		id: 'inner-gate',
		target: elementRef(),
		assertion: { kind: 'visible' },
		trueStepId: 'notify',
	})
	const flat = executorSteps.flattenSteps(steps)
	const domain = new Set(flat.map((item) => item.step.id))
	const conditions = []
	const collect = (list) => {
		for (const step of list) {
			if (step.kind === 'group') collect(step.steps)
			else if (step.kind === 'condition') conditions.push(step)
		}
	}
	collect(steps)
	assert.equal(conditions.length, 1)
	for (const target of [conditions[0].trueStepId, conditions[0].falseStepId]) {
		if (target) assert.ok(domain.has(target), `目标 ${target} 必须在扁平解析域内`)
	}
})

/* ---------------- 2.1 numberingOf 层级编号 ---------------- */

test('numberingOf keeps flat flows on the two-segment scheme', () => {
	const codes = FlowGraph.numberingOf({
		steps: [
			{ kind: 'group', id: 'g1', label: '一', steps: [waitStep('a'), waitStep('b')] },
			{ kind: 'group', id: 'g2', label: '二', steps: [waitStep('c')] },
		],
	})
	assert.equal(codes.get('g1'), '01')
	assert.equal(codes.get('a'), '01-01')
	assert.equal(codes.get('b'), '01-02')
	assert.equal(codes.get('g2'), '02')
	assert.equal(codes.get('c'), '02-01')
})

test('numberingOf extends hierarchically for nested and >3-level structures', () => {
	const codes = FlowGraph.numberingOf({ steps: nestedFlowSteps() })
	assert.equal(codes.get('stage-apply'), '01')
	assert.equal(codes.get('fill-form'), '01-01')
	assert.equal(codes.get('open-form'), '01-01-01')
	assert.equal(codes.get('fill-name'), '01-01-02')
	assert.equal(codes.get('submit'), '01-02')
	assert.equal(codes.get('stage-notify'), '02')
	assert.equal(codes.get('notify'), '02-01')

	const deep = [
		{
			kind: 'group',
			id: 'a',
			label: 'a',
			steps: [
				{
					kind: 'group',
					id: 'b',
					label: 'b',
					steps: [
						{
							kind: 'group',
							id: 'c',
							label: 'c',
							steps: [
								{ kind: 'group', id: 'd', label: 'd', steps: [waitStep('leaf')] },
							],
						},
					],
				},
			],
		},
	]
	const deepCodes = FlowGraph.numberingOf({ steps: deep })
	assert.equal(deepCodes.get('a'), '01')
	assert.equal(deepCodes.get('b'), '01-01')
	assert.equal(deepCodes.get('c'), '01-01-01')
	assert.equal(deepCodes.get('d'), '01-01-01-01')
	assert.equal(deepCodes.get('leaf'), '01-01-01-01-01')
})

test('numberingOf shares one positional sequence between groups and steps in a list', () => {
	// 同一父列表内组与步骤混排时共享位置序，保证编号不碰撞。
	const codes = FlowGraph.numberingOf({
		steps: [
			{
				kind: 'group',
				id: 'g',
				label: 'g',
				steps: [
					waitStep('s1'),
					{ kind: 'group', id: 'inner', label: 'inner', steps: [waitStep('s2')] },
					waitStep('s3'),
				],
			},
		],
	})
	assert.equal(codes.get('s1'), '01-01')
	assert.equal(codes.get('inner'), '01-02')
	assert.equal(codes.get('s2'), '01-02-01')
	assert.equal(codes.get('s3'), '01-03')
})

/* ---------------- 3.1 生成输出嵌套契约 ---------------- */

/** 通过 validateGenerationStructure 的标准 L1/L2 嵌套输出样本。 */
function generationSteps() {
	return [
		{
			kind: 'group',
			id: 'l1a',
			label: 'Open the workspace',
			targetSystem: 'CRM',
			steps: [
				{
					kind: 'group',
					id: 'l2a',
					label: 'Sign-in screen',
					targetSystem: 'CRM Web',
					steps: [waitStep('gate')],
				},
				waitStep('open'),
			],
		},
		{
			kind: 'group',
			id: 'l1b',
			label: 'Submit the order',
			steps: [waitStep('submit')],
		},
	]
}

test('generation structure accepts a valid nested L1/L2 output', () => {
	assert.deepEqual(aiRefine.validateGenerationStructure(generationSteps()), [])
})

test('generation structure rejects top-level count violations and bare top-level steps', () => {
	const single = [generationSteps()[0]]
	assert.ok(
		aiRefine.validateGenerationStructure(single).some((issue) => /2–6/.test(issue)),
	)
	const tooMany = []
	for (let i = 0; i < 7; i++)
		tooMany.push({ kind: 'group', id: `g${i}`, label: `G${i}`, steps: [waitStep(`s${i}`)] })
	assert.ok(
		aiRefine.validateGenerationStructure(tooMany).some((issue) => /2–6/.test(issue)),
	)
	const withBare = [...generationSteps(), waitStep('stray')]
	assert.ok(
		aiRefine
			.validateGenerationStructure(withBare)
			.some((issue) => /未分组步骤/.test(issue)),
	)
})

test('generation structure rejects nesting deeper than three levels', () => {
	const deep = structuredClone(generationSteps())
	deep[0].steps[0].steps.push({
		kind: 'group',
		id: 'l3-forbidden',
		label: 'L3 group',
		steps: [waitStep('too-deep')],
	})
	assert.ok(
		aiRefine.validateGenerationStructure(deep).some((issue) => /超出 3 级/.test(issue)),
	)
})

test('generation structure rejects missing labels, empty groups, and non-string targetSystem', () => {
	const noLabel = structuredClone(generationSteps())
	delete noLabel[1].label
	assert.ok(
		aiRefine.validateGenerationStructure(noLabel).some((issue) => /label 必填/.test(issue)),
	)
	const empty = structuredClone(generationSteps())
	empty[1].steps = []
	assert.ok(
		aiRefine.validateGenerationStructure(empty).some((issue) => /空分组/.test(issue)),
	)
	const badTag = structuredClone(generationSteps())
	badTag[1].targetSystem = 42
	assert.ok(
		aiRefine
			.validateGenerationStructure(badTag)
			.some((issue) => /targetSystem 必须是字符串/.test(issue)),
	)
})

test('generation prompt templates carry the nested contract without losing prior disciplines', () => {
	for (const template of [
		promptGenerationTemplates.autoSanitize,
		promptGenerationTemplates.refine,
	]) {
		assert.ok(template.includes('four quality gates'), '四层质量门纪律保留')
		assert.ok(template.includes('nested'), '嵌套多级输出契约在场')
		assert.ok(template.includes('targetSystem'), '目标系统标签提取在场')
		assert.ok(template.includes('never invent a system name'), '证据不足不编造')
		assert.ok(template.includes('2-6'), 'L1 数量约束在场')
	}
})

/* ---------------- 4.1 buildGraph 嵌套节点推导 ---------------- */

test('buildGraph keeps flat flows unchanged (no containers, same node ids)', () => {
	const g = FlowGraph.buildGraph({
		steps: [
			{ kind: 'group', id: 'g1', label: '一', steps: [waitStep('a'), waitStep('b')] },
			{ kind: 'group', id: 'g2', label: '二', steps: [waitStep('c')] },
		],
	})
	assert.ok(!g.nodes.some((n) => n.container), '扁平数据不产容器节点')
	assert.deepEqual(
		g.nodes.filter((n) => n.type === 'group').map((n) => n.id),
		['g1-part0', 'g2-part2'],
	)
	assert.deepEqual(
		g.edges.filter((e) => e.kind === 'flow').map((e) => e.to),
		['g1-part0', 'g2-part2', '__end_0'],
	)
})

test('buildGraph derives container nodes with nested cards and run cards', () => {
	const g = FlowGraph.buildGraph({ steps: nestedFlowSteps() })
	const container = g.nodeById.get('stage-apply')
	assert.ok(container && container.container === true)
	assert.equal(container.firstIndex, 0)
	assert.equal(container.lastIndex, 3)
	assert.equal(container.targetSystem, 'CRM')

	const l2 = g.nodeById.get('fill-form-part0')
	assert.ok(l2 && l2.type === 'group' && l2.containerId === 'stage-apply')

	const run = g.nodeById.get('stage-apply-run1-part2')
	assert.ok(run && run.type === 'ungrouped' && run.containerId === 'stage-apply')

	// 容器不抢步骤映射：分支目标解析到内层卡而非容器
	assert.equal(g.nodeByStepId.get('open-form'), l2)
	assert.equal(g.nodeByStepId.get('submit'), run)

	// 边不触碰容器端点（按执行语义连接卡与判定）
	for (const edge of g.edges) {
		assert.ok(!g.nodeById.get(edge.from)?.container, `边 ${edge.from} 起点不能是容器`)
		assert.ok(!g.nodeById.get(edge.to)?.container, `边 ${edge.to} 终点不能是容器`)
	}

	// 扁平兄弟组不受容器化影响
	const sibling = g.nodeById.get('stage-notify-part3')
	assert.ok(sibling && !sibling.containerId && !sibling.container)
	// 顺序链：L2 卡 → 直接步骤卡 → 下一顶层组卡
	const flowChain = g.edges.filter((e) => e.kind === 'flow').map((e) => e.to)
	assert.deepEqual(flowChain, ['fill-form-part0', 'stage-apply-run1-part2', 'stage-notify-part3', '__end_0'])
})

test('deleting a nested group with branch cleanup yields a strict-valid flow', () => {
	// 模拟 renderer 删除算法：摘除子树 → 收集被删步骤 id → 清理指向它们的
	// condition true/false 引用（clearDanglingBranchRefs 同款），结果必须过
	// strict 契约校验（无悬空引用、无空组、id 无冲突）。
	const steps = [
		{
			kind: 'group',
			id: 'stage-a',
			label: 'A',
			steps: [
				{
					kind: 'group',
					id: 'tech-a',
					label: 'A.tech',
					steps: [
						{ kind: 'click', id: 'act', target: elementRef() },
						{
							kind: 'condition',
							id: 'gate',
							target: elementRef(),
							assertion: { kind: 'visible' },
							trueStepId: 'gone-deep',
							falseStepId: 'far',
						},
					],
				},
				{
					kind: 'group',
					id: 'tech-b',
					label: 'B.tech',
					steps: [{ kind: 'wait', id: 'gone-deep', condition: 'timeout', ms: 5 }],
				},
			],
		},
		{
			kind: 'group',
			id: 'stage-b',
			label: 'B',
			steps: [{ kind: 'wait', id: 'far', condition: 'timeout', ms: 5 }],
		},
	]
	// 摘除 tech-b（gate 的 trueStepId 指向其内步骤 gone-deep）
	const stageA = steps[0]
	const techBIndex = stageA.steps.findIndex((s) => s.id === 'tech-b')
	const removed = stageA.steps.splice(techBIndex, 1)[0]
	const removedIds = new Set([removed.steps[0].id])
	// clearDanglingBranchRefs 同款清理
	const clear = (list) => {
		for (const step of list || []) {
			if (step?.kind === 'group') clear(step.steps)
			else if (step?.kind === 'condition') {
				if (step.trueStepId && removedIds.has(step.trueStepId)) delete step.trueStepId
				if (step.falseStepId && removedIds.has(step.falseStepId)) delete step.falseStepId
			}
		}
	}
	clear(steps)
	assert.equal(stageA.steps[0].steps[1].trueStepId, undefined)
	assert.equal(stageA.steps[0].steps[1].falseStepId, 'far')
	assert.doesNotThrow(() => flowIO.parseFlow(flow(steps), '<strict>', { strict: true }))
})
