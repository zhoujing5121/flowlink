import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

// add-swimlane-and-level-views 永久回归（纯数据推导，node:test 直测）：
// 1.2 buildGraph(flow, { level })：级别裁剪节点集合 + 边聚合（端点提升最近
//     level 祖先、平行边合并保标签、回跳按提升后端点重算）；>3 级延伸；
//     扁平数据 level 裁剪与全量视图等价（隐藏 L1 默认「下一级」）。
//     stepUnits 下钻视图：裸步骤逐张成卡 + condition 提取判定节点。
// 2.1 buildSwimlane：列 = targetSystem 去重（出现序）+ 未标注兜底；行 =
//     L1 阶段带（条件分支兄弟组合并 + 分支标题）；节点 = 次级任务卡；
//     lane 继承（自身 → 最近祖先 → 未标注）；网格坐标自算；边 = 执行顺序
//     链 + 分支边带标签；扁平数据单阶段退化。

let tempDir
let FlowGraph

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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-swimlane-levels-'))
	// flow-graph.js 是 window 全局脚本：垫片后再加载，取 window.FlowGraph。
	globalThis.window = globalThis
	await bundle('renderer/flow-graph.js', 'flow-graph')
	FlowGraph = globalThis.window.FlowGraph
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

const step = (id, extra = {}) => ({ kind: 'click', id, label: id, ...extra })
const condition = (id, trueStepId, falseStepId, label) => ({
	kind: 'condition',
	id,
	label: label || id,
	trueStepId,
	falseStepId,
})
const group = (id, steps, extra = {}) => ({
	kind: 'group',
	id,
	label: id,
	steps,
	...extra,
})
const idsOf = (nodes, type) =>
	nodes.filter((node) => !type || node.type === type).map((node) => node.id).sort()
const edgeKeys = (edges) =>
	edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}:${edge.label || ''}`)

// —— 夹具：深度 2（L1 g1 嵌套 s1/s2 + L1 g2 扁平）——
const nestedFlow = {
	steps: [
		group('g1', [
			group('s1', [step('a1'), condition('c1', 't1', null, '是否需要审批')]),
			group('s2', [step('a2')]),
		], { targetSystem: '门户' }),
		group('g2', [step('t1'), step('t2')]),
	],
}

test('groupDepthOf 枚举实际深度（嵌套 2 / 扁平 1 / 四级 4）', () => {
	assert.equal(FlowGraph.groupDepthOf(nestedFlow.steps), 2)
	assert.equal(FlowGraph.groupDepthOf([step('x')]), 0)
	assert.equal(
		FlowGraph.groupDepthOf([group('g1', [group('s1', [group('u1', [group('v1', [step('d1')])])])])]),
		4,
	)
})

test('buildGraph level=1：L1 组为叶子卡，无容器、无内层卡', () => {
	const graph = FlowGraph.buildGraph(nestedFlow, { level: 1 })
	assert.ok(graph.nodes.every((node) => !node.container))
	const cardIds = graph.nodes
		.filter((node) => node.type === 'group' || node.type === 'ungrouped')
		.map((node) => node.id)
	assert.ok(cardIds.some((id) => id.startsWith('g1-part')), 'g1 切分卡存在')
	assert.ok(cardIds.includes('g2-part3'), 'g2 整卡存在')
	assert.ok(!cardIds.some((id) => id.startsWith('s1') || id.startsWith('s2')))
})

test('buildGraph level=1：分支边端点提升到 L1 卡并保留标签', () => {
	const graph = FlowGraph.buildGraph(nestedFlow, { level: 1 })
	const branch = graph.edges.find((edge) => edge.label === '是')
	assert.ok(branch, '存在「是」分支边')
	assert.equal(branch.to, 'g2-part3', '目标提升到覆盖 t1 的 L1 卡')
	assert.equal(branch.from, 'cond-g1-s1-c1', '源为提升后的判定节点')
	assert.equal(branch.kind, 'branch')
	const noEdge = graph.edges.find((edge) => edge.label === '否')
	assert.ok(noEdge, '缺省否分支顺序继续')
	assert.equal(noEdge.kind, 'flow')
})

test('buildGraph level=1：回跳按提升后端点重算为 back', () => {
	const flow = {
		steps: [
			group('g1', [step('a1')]),
			group('g2', [step('t1'), condition('c2', 't1', null, '重试?'), step('t2')]),
		],
	}
	const graph = FlowGraph.buildGraph(flow, { level: 1 })
	const back = graph.edges.find(
		(edge) => edge.kind === 'back' && edge.label === '是',
	)
	assert.ok(back, '目标序 ≤ 源序判定为回跳')
	assert.equal(back.from, 'cond-g2-c2')
	assert.equal(back.to, 'g2-part1', 't1 所在 L1 切分卡')
})

test('buildGraph 平行边合并：完全相同的重复边只保留一条，不同标签保留', () => {
	const flow = {
		steps: [
			group('g1', [step('a1'), condition('c1', null, null), condition('c2', null, null)]),
			group('g2', [step('t1')]),
		],
	}
	const graph = FlowGraph.buildGraph(flow, { level: 1 })
	const same = edgeKeys(graph.edges).filter((key) => key.endsWith(':flow:是'))
	const pairs = graph.edges
		.filter((edge) => edge.label === '是')
		.map((edge) => `${edge.from}->${edge.to}`)
	const uniquePairs = new Set(pairs)
	// 两个缺省「是」分支落在不同判定→不同切分卡之间（不合并），但同对重复必须去重
	assert.equal(pairs.length, uniquePairs.size, '不存在同端点同标签重复边')
	assert.ok(same.length >= 1)
})

test('buildGraph level=2 等价全量视图；扁平数据 level 裁剪等价 legacy', () => {
	const level2 = FlowGraph.buildGraph(nestedFlow, { level: 2 })
	const full = FlowGraph.buildGraph(nestedFlow)
	assert.deepEqual(level2.nodes, full.nodes)
	assert.deepEqual(level2.edges, full.edges)

	const flatFlow = {
		steps: [group('g1', [step('a1'), step('a2')]), group('g2', [step('t1')])],
	}
	const flatLevel = FlowGraph.buildGraph(flatFlow, { level: 1 })
	const flatFull = FlowGraph.buildGraph(flatFlow)
	assert.deepEqual(flatLevel.nodes, flatFull.nodes)
	assert.deepEqual(flatLevel.edges, flatFull.edges)
})

test('buildGraph >3 级延伸：level=3 叶子卡在第 3 级，上层为容器', () => {
	const deepFlow = {
		steps: [
			group('g1', [group('s1', [group('u1', [group('v1', [step('d1')])]), step('d2')])]),
		],
	}
	const view3 = FlowGraph.buildGraph(deepFlow, { level: 3 })
	const containers = view3.nodes.filter((node) => node.container).map((node) => node.id)
	assert.deepEqual(containers.sort(), ['g1', 's1'])
	const leaves = view3.nodes.filter((node) => node.type === 'group' && !node.container)
	assert.deepEqual(leaves.map((node) => node.id), ['u1-part0'])
	const view2 = FlowGraph.buildGraph(deepFlow, { level: 2 })
	assert.deepEqual(
		view2.nodes.filter((node) => node.type === 'group' && !node.container).map((node) => node.id),
		['s1-part0'],
	)
	assert.deepEqual(
		view2.nodes.filter((node) => node.container).map((node) => node.id).sort(),
		['g1'],
	)
})

test('buildGraph stepUnits（下钻）：裸步骤逐张成卡，condition 提取判定节点', () => {
	const drill = FlowGraph.buildGraph(
		{ steps: [step('a1'), condition('c1', 't1', null), step('t1'), step('a2')] },
		{ level: 1, stepUnits: true },
	)
	const stepCards = drill.nodes.filter((node) => node.type === 'step').map((node) => node.id)
	assert.deepEqual(stepCards, ['step-a1-part0', 'step-t1-part2', 'step-a2-part3'])
	const decision = drill.nodes.find((node) => node.type === 'decision')
	assert.ok(decision, 'condition 提取为判定节点')
	// 分支目标按裸步骤 id 解析到步骤卡
	const branch = drill.edges.find((edge) => edge.label === '是')
	assert.equal(branch.to, 'step-t1-part2')
	assert.equal(branch.kind, 'branch')
})

// —— 泳道夹具 ——
const swimFlow = {
	steps: [
		group('p1', [
			group('s1', [step('k1')], { targetSystem: '订单系统' }),
			group('s2', [step('k2')]),
		], { targetSystem: '门户' }),
		group('p2', [step('k3'), condition('cc', 'k5', null, '并行提交审核')]),
		group('p3', [step('k5')], { targetSystem: 'ERP' }),
	],
}

test('buildSwimlane 列：targetSystem 出现序去重 + 未标注兜底列', () => {
	const lane = FlowGraph.buildSwimlane(swimFlow, () => ({ height: 48 }))
	assert.deepEqual(
		lane.columns.map((column) => column.name),
		['订单系统', '门户', 'ERP', '未标注'],
	)
})

test('buildSwimlane lane 继承：自身 → L1 祖先 → 未标注', () => {
	const lane = FlowGraph.buildSwimlane(swimFlow, () => ({ height: 48 }))
	const byId = new Map(lane.tasks.map((task) => [task.id, task]))
	assert.equal(byId.get('s1').laneKey, '订单系统')
	assert.equal(byId.get('s2').laneKey, '门户', '无自身标签继承 L1')
	assert.equal(byId.get('step:p2/k3').laneKey, '', '无标签归未标注')
	const laneIndexOf = new Map(lane.columns.map((column, index) => [column.key ?? '', index]))
	assert.equal(byId.get('step:p2/k3').laneIndex, laneIndexOf.get(''))
})

test('buildSwimlane 阶段带：分支兄弟 L1 组合并 + 编号区间标题 + 分支标题', () => {
	const siblingFlow = {
		steps: [
			group('a', [step('x1')]),
			group('b', [step('y1')]),
			group('c', [step('z1')]),
			group('d', [condition('pick', 'y1', 'z1', '并行提交审核')]),
		],
	}
	const siblingLane = FlowGraph.buildSwimlane(siblingFlow, () => ({ height: 48 }))
	// a、b+c（合并）、d 三条带
	assert.equal(siblingLane.bands.length, 3)
	const merged = siblingLane.bands.find((band) => band.title.includes('–'))
	assert.ok(merged, '存在合并带（编号区间标题）')
	assert.equal(merged.title, '02–03', '区间从首成员编号到末成员编号')
	assert.equal(merged.branchLabel, '并行提交审核')
	assert.deepEqual(merged.groupIds, ['b', 'c'])
	// 合并带内任务按执行顺序排列（y1 在 z1 前）
	const inBand = siblingLane.tasks.filter(
		(task) => task.bandIndex === siblingLane.bands.indexOf(merged),
	)
	assert.deepEqual(inBand.map((task) => task.id), ['step:b/y1', 'step:c/z1'])
})

test('buildSwimlane 落位：列 × 带网格坐标自算，顺序任务纵向排布、跨带下移', () => {
	const lane = FlowGraph.buildSwimlane(swimFlow, () => ({ height: 48 }))
	const byId = new Map(lane.tasks.map((task) => [task.id, task]))
	const s1 = byId.get('s1')
	const s2 = byId.get('s2')
	// 同带顺序任务（不同列）：纵向堆叠（槽序推进 + 行距）
	assert.equal(s1.bandIndex, s2.bandIndex)
	assert.ok(s2.y >= s1.y + s1.height, '下一槽在上一槽之下')
	assert.notEqual(s1.x, s2.x, '不同列不同 x')
	// 跨带任务继续下移；Start/End 纵向首尾
	assert.ok(byId.get('step:p2/k3').y > s2.y)
	assert.ok(lane.end.y > lane.start.y)
	assert.ok(lane.worldWidth > lane.laneLeft)
})

test('buildSwimlane 扁平数据退化：单阶段带 + 步骤卡 + 顺序链', () => {
	const flat = {
		steps: [group('g1', [step('a1'), step('a2'), step('a3')])],
	}
	const lane = FlowGraph.buildSwimlane(flat, () => ({ height: 48 }))
	assert.equal(lane.bands.length, 1)
	assert.deepEqual(
		lane.columns.map((column) => column.name),
		['未标注'],
	)
	assert.deepEqual(
		lane.tasks.map((task) => task.type),
		['step', 'step', 'step'],
	)
	const chain = lane.edges.filter((edge) => edge.kind === 'flow')
	assert.equal(chain.length, 2)
	assert.equal(chain[0].from, 'step:g1/a1')
	assert.equal(chain[0].to, 'step:g1/a2')
})

test('buildSwimlane 分支边：condition 不成卡，边源回溯覆盖任务并带标签', () => {
	const lane = FlowGraph.buildSwimlane(swimFlow, () => ({ height: 48 }))
	assert.ok(lane.tasks.every((task) => task.type !== 'condition'))
	const branch = lane.edges.find((edge) => edge.label === '是')
	assert.ok(branch, '存在「是」分支边')
	assert.equal(branch.from, 'step:p2/k3', '源回溯到条件前的任务卡')
	assert.equal(branch.to, 'step:p3/k5')
})
