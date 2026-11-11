import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let flowIO
let planner
let steps
let classify
let systems
let coalesce
let archive
let aiRefine
let actions

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
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-flow-authoring-'))
	;[flowIO, planner, steps, classify, systems, coalesce, archive, aiRefine, actions] = await Promise.all([
		bundle('engine/schema/src/io.ts', 'flow-io'),
		bundle('engine/recorder/src/plan.ts', 'plan'),
		bundle('engine/executor/src/steps.ts', 'steps'),
		bundle('engine/recorder/src/classify.ts', 'classify'),
		bundle('engine/recorder/src/systems.ts', 'systems'),
		bundle('engine/recorder/src/coalesce.ts', 'coalesce'),
		bundle('engine/recorder/src/flowforge-archive.ts', 'flowforge-archive'),
		bundle('src/ai-refine.ts', 'ai-refine'),
		bundle('engine/executor/src/actions.ts', 'actions'),
	])
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

function flow(steps, schemaVersion = 1) {
	return {
		schemaVersion,
		id: 'flow-test',
		title: 'Flow test',
		createdAt: '2025-01-01T00:00:00.000Z',
		meta: {
			env: {
				startUrl: 'https://example.test',
				viewport: { width: 800, height: 600 },
			},
			recorder: { name: 'test', version: '1' },
		},
		steps,
	}
}

test('migrates schema v1 and validates condition branches against existing groups', () => {
	const target = elementRef()
	const input = flow([
		{
			kind: 'group',
			id: 'first',
			label: 'First',
			steps: [{
				kind: 'condition',
				id: 'branch',
				target,
				assertion: { kind: 'visible' },
				trueGroupId: 'second',
			}],
		},
		{
			kind: 'group',
			id: 'second',
			label: 'Second',
			steps: [{ kind: 'wait', id: 'pause', condition: 'timeout', ms: 10 }],
		},
	])

	const parsed = flowIO.parseFlow(input)
	assert.equal(parsed.schemaVersion, 2)

	const invalid = structuredClone(parsed)
	invalid.steps[0].steps[0].trueGroupId = 'missing'
	assert.throws(() => flowIO.parseFlow(invalid), /不存在的 group/)
})

test('rejects conditions before the end of a group and literal password assertions', () => {
	const target = elementRef('password')
	const input = flow([
		{
			kind: 'group',
			id: 'first',
			label: 'First',
			steps: [
				{
					kind: 'condition',
					id: 'branch',
					target,
					assertion: { kind: 'value', equals: 'plaintext' },
				},
				{ kind: 'wait', id: 'pause', condition: 'timeout', ms: 10 },
			],
		},
	])
	assert.throws(() => flowIO.parseFlow(input), /condition.*最后一步/)
	assert.throws(() => flowIO.parseFlow(input), /password 条件必须引用 secret 变量/)
})

test('records a new tab and the following switch back as distinct actions', () => {
	const state = { page: 0 }
	const items = planner.withTabSwitches([], state, [
		{ action: 'tabCreated', ts: 10, index: 1, url: 'about:blank' },
		{ action: 'tabActivated', ts: 20, index: 0 },
	])
	assert.deepEqual(items.map((item) => [item.kind, item.index, item.url]), [
		['openTab', 1, 'about:blank'],
		['switchTab', 0, undefined],
	])
	assert.equal(state.page, 0)
})

test('prefixes preserve groups and remove branch targets outside the prefix', () => {
	const original = [
		{
			kind: 'group',
			id: 'first',
			label: 'First',
			steps: [{
				kind: 'condition',
				id: 'branch',
				target: elementRef(),
				assertion: { kind: 'visible' },
				trueGroupId: 'second',
			}],
		},
		{
			kind: 'group',
			id: 'second',
			label: 'Second',
			steps: [{ kind: 'wait', id: 'pause', condition: 'timeout', ms: 10 }],
		},
	]
	const prefix = steps.prefixSteps(original, 1)
	assert.equal(prefix.length, 1)
	assert.equal(prefix[0].kind, 'group')
	assert.equal(prefix[0].steps[0].kind, 'condition')
	assert.equal(prefix[0].steps[0].trueGroupId, undefined)
	assert.equal(original[0].steps[0].trueGroupId, 'second')
})

test('Process renderer calls the exposed preload API for hydration and edits', async () => {
	const app = await readFile(join(process.cwd(), 'renderer/app.js'), 'utf8')
	assert.doesNotMatch(app, /\bF\.(?:flow|recording|browser)\./)
	assert.match(app, /window\.flowlink\.flow\.load\(item\.flowFile\)/)
	assert.match(app, /window\.flowlink\.flow\.updateSteps\(/)
	assert.match(app, /showManualStepEditor\(item, addStep\.dataset\.groupAddStep\)/)
	assert.match(app, /addProcessGroupAfter\(item, addAfter\.dataset\.groupAddAfter\)/)
})

test('AI pane chat stays text-only: attachments are id/name chips and generation goes through pi.generateFlow', async () => {
	const app = await readFile(join(process.cwd(), 'renderer/app.js'), 'utf8')
	// 生成走主进程 pi.generateFlow，只传录制 id —— 渲染层不再拼装/截断步骤 JSON
	assert.match(app, /bridge\.generateFlow\(\{\s*taskCode, recordingIds, instruction: request, conversation \}\)/)
	assert.doesNotMatch(app, /Source executable steps/)
	// 聊天条目中的附件只存 id/name 芯片；发送后清空，绝无 Flow 载荷
	assert.match(app, /attachments: attachmentItems\.map\(\(entry\) => \(\{\s*id: entry\.recordingId \|\| entry\.id,\s*name: entry\.name,\s*\}\)\)/)
	assert.match(app, /state\.aiAttachments = \[\]/)
	assert.match(app, /invokeAIMerge\("input", message, \{ attachments: state\.aiAttachments \}\)/)
})

/* ------------------------------------------------------------------ */
/* Automatic auth classification + optional navigation steps          */
/* ------------------------------------------------------------------ */

test('compileAuthMatchers merges custom patterns with defaults and skips invalid regexes', () => {
	const custom = classify.compileAuthMatchers({
		idpHostPatterns: ['(^|\\.)corp-idp(\\.|$)'],
		loginPathPatterns: ['^/affiliates-signin'],
	})
	// 自定义主机名规则 / 路径规则各自命中默认规则覆盖不到的 URL
	assert.equal(classify.isAuthUrl('https://corp-idp.vendor.io/home', custom), true)
	assert.equal(classify.isAuthUrl('https://normal.example.com/affiliates-signin', custom), true)
	assert.equal(classify.isAuthUrl('https://normal.example.com/home', custom), false)
	// 空配置 → 仅默认规则
	const defaults = classify.compileAuthMatchers()
	assert.equal(defaults.host.length, 1)
	assert.equal(defaults.path.length, 1)
	assert.equal(defaults.warnings.length, 0)
	assert.equal(classify.isAuthUrl('https://login.example.com/x', defaults), true)
	// 无效正则跳过并告警，默认规则照常生效
	const invalid = classify.compileAuthMatchers({ idpHostPatterns: ['([unclosed'], loginPathPatterns: ['a(??'] })
	assert.equal(invalid.host.length, 1)
	assert.equal(invalid.path.length, 1)
	assert.equal(invalid.warnings.length, 2)
	assert.equal(classify.isAuthUrl('https://sso.example.com/', invalid), true)
})

test('isAuthUrl matches host or path and rejects unparseable input', () => {
	const matchers = classify.compileAuthMatchers()
	assert.equal(classify.isAuthUrl('https://login.corp.io/dashboard', matchers), true)
	assert.equal(classify.isAuthUrl('https://app.corp.io/oauth/authorize?x=1', matchers), true)
	assert.equal(classify.isAuthUrl('https://app.corp.io/dashboard', matchers), false)
	assert.equal(classify.isAuthUrl('not a url', matchers), false)
})

test('auto-classified redirects stay out of coalescing and become optional navigate actions', () => {
	const facts = { uid: 'u1', tag: 'button', attributes: {}, rect: { x: 0, y: 0, width: 10, height: 10 }, scroll: { x: 0, y: 0 }, viewport: { width: 800, height: 600 }, dpr: 1, recordedAt: 1 }
	const click = { kind: 'click', ts: 1000, trusted: true, facts, pageIndex: 0 }
	const redirect = { kind: 'navigation', ts: 1200, url: 'https://login.corp.io/', previousUrl: 'https://app.corp.io/', navigationType: 'sso_redirect', directNavigation: false, pageIndex: 0 }
	// 若重定向直接进入合流器，它会并进前一个动作的 expectUrl（这就是必须前置剔除的原因）
	const unfiltered = coalesce.coalesceEvents([click, redirect])
	assert.equal(unfiltered.length, 1)
	assert.equal(unfiltered[0].expectUrl, 'https://login.corp.io/')
	// processBatch 的顺序：按 AUTO_NAVIGATION_TYPES 剔除后合流，被剔除事件单独合成可选导航
	const kept = [click, redirect].filter(
		(event) => !(event.kind === 'navigation' && classify.AUTO_NAVIGATION_TYPES.has(event.navigationType)),
	)
	const executable = coalesce.coalesceEvents(kept)
	assert.equal(executable.length, 1)
	assert.equal(executable[0].expectUrl, undefined)
	const optional = planner.synthesizeOptionalNavigations([redirect])
	assert.equal(optional.length, 1)
	assert.equal(optional[0].kind, 'navigate')
	assert.equal(optional[0].url, 'https://login.corp.io/')
	assert.equal(optional[0].previousUrl, 'https://app.corp.io/')
	assert.equal(optional[0].navigationType, 'sso_redirect')
	assert.equal(optional[0].pageIndex, 0)
	assert.equal(optional[0].raw.length, 1)
	// 非机器跳转类型不合成可选导航
	assert.equal(planner.synthesizeOptionalNavigations([{ ...redirect, navigationType: 'user_link' }]).length, 0)
	assert.deepEqual([...classify.AUTO_NAVIGATION_TYPES].sort(), ['auto_redirect', 'login_redirect', 'sso_redirect'])
})

test('refineSteps keeps optional navigations separate from openTab merges', () => {
	const refined = planner.refineSteps([
		{ kind: 'openTab', id: 's1', page: { index: 1 } },
		{ kind: 'navigate', id: 's2', url: 'https://idp.io/auth', isOptional: true, previousUrl: 'https://app.io/', page: { index: 1 } },
	])
	// isOptional 的 navigate 绝不能并入 openTab——并入会丢掉可选标记与回放跳过判定
	assert.equal(refined.length, 2)
	assert.equal(refined[0].kind, 'openTab')
	assert.equal(refined[0].url, undefined)
	assert.equal(refined[1].isOptional, true)
	// 普通导航仍然并入
	const plain = planner.refineSteps([
		{ kind: 'openTab', id: 's1', page: { index: 1 } },
		{ kind: 'navigate', id: 's2', url: 'https://app.io/home', page: { index: 1 } },
	])
	assert.equal(plain.length, 1)
	assert.equal(plain[0].url, 'https://app.io/home')
})

test('sameSitePath compares origin and pathname only, ignoring query and hash', () => {
	// SSO 往返带每次运行都不同的 state/nonce → 必须忽略 query；hash 路由不覆盖（已知限制）
	assert.equal(actions.sameSitePath('https://app.io/list?state=abc&nonce=1', 'https://app.io/list#x'), true)
	assert.equal(actions.sameSitePath('https://app.io/list/', 'https://app.io/list'), false)
	assert.equal(actions.sameSitePath('https://app.io/list', 'https://app.io/other'), false)
	assert.equal(actions.sameSitePath('https://app.io/', 'http://app.io/'), false)
	assert.equal(actions.sameSitePath('not a url', 'https://app.io/'), false)
	assert.equal(actions.OPTIONAL_NAV_WAIT_MS, 800)
})

test('navigate steps accept isOptional for replay-tolerant flows', () => {
	const parsed = flowIO.parseFlow(flow([
		{ kind: 'navigate', id: 's1', url: 'https://app.io/' },
		{ kind: 'navigate', id: 's2', url: 'https://idp.io/auth', isOptional: true, previousUrl: 'https://app.io/' },
	]))
	assert.equal(parsed.steps[0].isOptional, undefined)
	assert.equal(parsed.steps[1].isOptional, true)
})

/* ------------------------------------------------------------------ */
/* 4B — system alias map                                              */
/* ------------------------------------------------------------------ */

test('resolveSystem collapses aliased hostnames and preserves the fallback identities', () => {
	const aliases = { 'a.corp.example': 'ERP', 'B.CORP.EXAMPLE': 'ERP' }
	assert.deepEqual(systems.resolveSystem('https://a.corp.example/x', aliases), { systemId: 'erp', systemName: 'ERP', domain: 'a.corp.example' })
	assert.deepEqual(systems.resolveSystem('https://b.corp.example/y', aliases), { systemId: 'erp', systemName: 'ERP', domain: 'b.corp.example' })
	// 未命中 → 裸主机名行为
	assert.deepEqual(systems.resolveSystem('https://Other.Corp.io/z', aliases), { systemId: 'other-corp-io', systemName: 'other.corp.io', domain: 'other.corp.io' })
	// 特殊回退：非 http(s) → browser；解析失败 → unknown-system
	assert.deepEqual(systems.resolveSystem('about:blank', aliases), { systemId: 'browser', systemName: 'Browser' })
	assert.deepEqual(systems.resolveSystem('', aliases), { systemId: 'unknown-system', systemName: 'Unknown system' })
})

test('flowforge archive collapses aliased hostnames into one aggregated system entry', async () => {
	const rawPath = join(tempDir, 'classification-raw.json')
	await writeFile(rawPath, JSON.stringify({
		startUrl: 'https://a.corp.example/',
		warnings: [],
		events: [
			{ eventId: 'e1', kind: 'click', ts: 1000, pageIndex: 0, frameUrl: 'https://a.corp.example/list', trusted: true, facts: { tag: 'button', attributes: {}, rect: { x: 0, y: 0, width: 10, height: 10 }, scroll: { x: 0, y: 0 }, viewport: { width: 800, height: 600 }, dpr: 1, recordedAt: 1 } },
			{ eventId: 'e2', kind: 'navigation', ts: 1200, pageIndex: 0, url: 'https://login.corp.io/', previousUrl: 'https://a.corp.example/', navigationType: 'sso_redirect', directNavigation: false, trusted: true },
		],
	}))
	const flow = { schemaVersion: 2, id: 'flow-x', title: 'X', createdAt: '2026-01-01T00:00:00.000Z', meta: { env: { startUrl: 'https://a.corp.example/' } }, steps: [] }
	const tabs = [
		{ tabId: 't0', url: 'https://a.corp.example/list', title: 'A', active: true, systemId: 'erp', systemName: 'ERP', pageIndex: 0 },
		{ tabId: 't1', url: 'https://b.corp.example/list', title: 'B', active: false, systemId: 'erp', systemName: 'ERP', pageIndex: 1 },
		{ tabId: 't2', url: 'https://other.io/', title: 'C', active: false, systemId: 'other-io', systemName: 'other.io', pageIndex: 2 },
	]
	const target = await archive.writeFlowForgeArchive(rawPath, flow, tabs, join(tempDir, 'archive-out'), [], {
		matchers: classify.compileAuthMatchers(),
		aliases: { 'a.corp.example': 'ERP', 'b.corp.example': 'ERP' },
	})
	assert.ok(target)
	const sidecar = JSON.parse(await readFile(target, 'utf8'))
	assert.deepEqual(sidecar.systems, [
		{ systemId: 'erp', name: 'ERP', domains: ['a.corp.example', 'b.corp.example'] },
		{ systemId: 'other-io', name: 'other.io', domains: ['other.io'] },
	])
	// 事件走同一份别名解析；认证重定向保留在证据 events[] 里且带 navigationType
	const click = sidecar.events.find((event) => event.eventId === 'e1')
	assert.equal(click.systemId, 'erp')
	assert.equal(click.systemName, 'ERP')
	const redirect = sidecar.events.find((event) => event.eventId === 'e2')
	assert.equal(redirect.navigationType, 'sso_redirect')
	assert.equal(redirect.url, 'https://login.corp.io/')
})

/* ------------------------------------------------------------------ */
/* 4C — drag: evidence to executable step                              */
/* ------------------------------------------------------------------ */

function dragFacts(uid) {
	return { uid, tag: 'li', attributes: {}, rect: { x: 0, y: 0, width: 100, height: 20 }, scroll: { x: 0, y: 0 }, viewport: { width: 800, height: 600 }, dpr: 1, recordedAt: 1 }
}

test('coalesceEvents pairs dragStart and drop into one drag action', () => {
	const actions = coalesce.coalesceEvents([
		{ kind: 'dragStart', ts: 1000, pageIndex: 0, trusted: true, facts: dragFacts('u1') },
		{ kind: 'drop', ts: 2000, pageIndex: 0, trusted: true, facts: dragFacts('u2'), frameIndex: 0, frameUrl: 'https://x.io/' },
	])
	assert.equal(actions.length, 1)
	assert.equal(actions[0].kind, 'drag')
	assert.equal(actions[0].from.uid, 'u1')
	assert.equal(actions[0].to.uid, 'u2')
	assert.equal(actions[0].ts, 2000)
	assert.equal(actions[0].pageIndex, 0)
	assert.equal(actions[0].frameUrl, 'https://x.io/')
	assert.equal(actions[0].raw.length, 2)
})

test('unpaired, stale, cross-page or interrupted drags stay evidence-only', () => {
	// 孤儿 drop
	assert.equal(coalesce.coalesceEvents([
		{ kind: 'drop', ts: 1500, pageIndex: 0, trusted: true, facts: dragFacts('u2') },
	]).length, 0)
	// 超出配对窗口
	assert.equal(coalesce.coalesceEvents([
		{ kind: 'dragStart', ts: 1000, pageIndex: 0, trusted: true, facts: dragFacts('u1') },
		{ kind: 'drop', ts: 1000 + coalesce.DRAG_PAIR_MS + 1, pageIndex: 0, trusted: true, facts: dragFacts('u2') },
	]).length, 0)
	// 跨页不配对
	assert.equal(coalesce.coalesceEvents([
		{ kind: 'dragStart', ts: 1000, pageIndex: 0, trusted: true, facts: dragFacts('u1') },
		{ kind: 'drop', ts: 1200, pageIndex: 1, trusted: true, facts: dragFacts('u2') },
	]).length, 0)
	// 中间出现其他动作 → 配对作废（click 保留为正常动作）
	const interrupted = coalesce.coalesceEvents([
		{ kind: 'dragStart', ts: 1000, pageIndex: 0, trusted: true, facts: dragFacts('u1') },
		{ kind: 'click', ts: 1100, pageIndex: 0, trusted: true, facts: dragFacts('u3') },
		{ kind: 'drop', ts: 1300, pageIndex: 0, trusted: true, facts: dragFacts('u2') },
	])
	assert.deepEqual(interrupted.map((action) => action.kind), ['click'])
	// 新 dragStart 重置待配对槽
	const reset = coalesce.coalesceEvents([
		{ kind: 'dragStart', ts: 1000, pageIndex: 0, trusted: true, facts: dragFacts('u1') },
		{ kind: 'dragStart', ts: 1100, pageIndex: 0, trusted: true, facts: dragFacts('u3') },
		{ kind: 'drop', ts: 1300, pageIndex: 0, trusted: true, facts: dragFacts('u2') },
	])
	assert.equal(reset.length, 1)
	assert.equal(reset[0].kind, 'drag')
	assert.equal(reset[0].from.uid, 'u3')
	assert.equal(reset[0].to.uid, 'u2')
})

test('recorded drag steps with resolved from/to refs parse as valid flows', () => {
	const parsed = flowIO.parseFlow(flow([
		{ kind: 'drag', id: 's1', from: elementRef(), to: { target: elementRef() } },
	]))
	assert.equal(parsed.steps[0].kind, 'drag')
})

/* ------------------------------------------------------------------ */
/* 5 — AI refinement pipeline ($ref projection / rehydration)          */
/* ------------------------------------------------------------------ */

function refineableSteps(target) {
	return [
		{ kind: 'navigate', id: 's0', url: 'https://example.test', navigationType: 'initial' },
		{
			kind: 'click',
			id: 's1',
			label: 'Open form',
			page: { index: 1 },
			target,
			expect: { kind: 'elementVisible', target },
		},
		{ kind: 'input', id: 's2', target, value: 'hello' },
		{ kind: 'drag', id: 's3', from: target, to: { target, x: 4, y: 5 } },
		{ kind: 'wait', id: 's4', condition: 'element', target, ms: 500 },
		{
			kind: 'group',
			id: 'g1',
			label: 'Stage',
			steps: [{ kind: 'navigate', id: 's5', url: 'https://example.test/next' }],
		},
	]
}

test('projection replaces every ElementRef with a $ref and rehydration round-trips deep-equal', () => {
	const parsed = flowIO.parseFlow(flow(refineableSteps(elementRef())))
	const projection = aiRefine.projectFlows([parsed])
	// 投影后元素位置只剩 {"$ref":"eN"}，且同一元素在库中只登记一次
	const projected = JSON.parse(projection.flows[0].stepsJson)
	assert.deepEqual(projected[1].target, { $ref: 'e1' })
	assert.deepEqual(projected[1].expect.target, { $ref: 'e1' })
	assert.deepEqual(projected[3].from, { $ref: 'e1' })
	assert.deepEqual(projected[3].to.target, { $ref: 'e1' })
	assert.equal(projection.library.length, 1)
	assert.match(projection.libraryLines[0], /^e1 · input/)
	// 再水化后与原始（解析后的）步骤完全一致 —— observed 证据逐字节保留
	const rehydrated = aiRefine.rehydrateSteps(projected, projection.library)
	assert.deepEqual(rehydrated, parsed.steps)
})

test('rehydration rejects unknown $ref ids and inline element objects', () => {
	const library = [{ id: 'e1', ref: elementRef(), origin: 'test', summary: 'e1' }]
	assert.throws(
		() => aiRefine.rehydrateSteps([{ kind: 'click', id: 'c1', target: { $ref: 'e99' } }], library),
		/unknown element reference "e99"/,
	)
	assert.throws(
		() => aiRefine.rehydrateSteps([{ kind: 'click', id: 'c1', target: elementRef() }], library),
		/inline element data is not allowed/,
	)
	assert.throws(
		() => aiRefine.rehydrateSteps([{ kind: 'click', id: 'c1', target: { $ref: 'e1', observed: {} } }], library),
		/inline element data is not allowed/,
	)
})

test('extractJsonObject handles plain, fenced, prose-wrapped and invalid responses', () => {
	assert.deepEqual(aiRefine.extractJsonObject('{"title":"x"}'), { title: 'x' })
	assert.deepEqual(aiRefine.extractJsonObject('```json\n{"title":"x"}\n```'), { title: 'x' })
	// 括号配对扫描必须跳过字符串内的花括号
	const prose = 'Sure! Here is the object:\n{"title":"x","data":{"evil":"}{"},"steps":[]} hope it helps'
	assert.equal(aiRefine.extractJsonObject(prose).title, 'x')
	assert.throws(() => aiRefine.extractJsonObject('no json here'), /valid JSON/)
	assert.throws(() => aiRefine.extractJsonObject(''), /empty response/)
})

test('mergeVariables keeps the first non-secret default and sanitizes Pi-proposed variables', () => {
	const varA = { name: 'user', type: 'string', defaultValue: 'bob', secret: false, source: 'input' }
	const noDefault = { name: 'user', type: 'string', secret: false, source: 'input' }
	const laterDefault = { name: 'user', type: 'string', defaultValue: 'alice', secret: false, source: 'input' }
	const secretVar = { name: 'pass', type: 'secret', secret: true, source: 'input' }
	const flowA = { ...flow([]), variables: [noDefault, secretVar] }
	const flowB = { ...flow([]), variables: [varA, laterDefault] }
	const merged = aiRefine.mergeVariables([flowA, flowB], [
		{ name: 'count', defaultValue: '3' },
		{ name: '1invalid', defaultValue: 'x' },
		{ name: 'leak', secret: true, defaultValue: 'nope' },
	])
	const byName = Object.fromEntries(merged.map((variable) => [variable.name, variable]))
	// 首个非 secret 默认值生效；secret 变量保留；Pi 输出只接受合法命名且非 secret 的条目
	assert.equal(byName.user.defaultValue, 'bob')
	assert.equal(byName.pass.secret, true)
	assert.equal(byName.count.defaultValue, '3')
	assert.equal(byName['1invalid'], undefined)
	assert.equal(byName.leak, undefined)
})

test('rehydration de-duplicates colliding ids and generates ids for new steps', () => {
	const rehydrated = aiRefine.rehydrateSteps([
		{ kind: 'navigate', id: 's1', url: 'https://a.test' },
		{ kind: 'wait', id: 's1', condition: 'timeout', ms: 5 },
		{ kind: 'wait', id: 's1', condition: 'timeout', ms: 6 },
		{ kind: 'navigate', url: 'https://b.test' },
	], [])
	assert.deepEqual(rehydrated.map((step) => step.id), [rehydrated[0].id, 's1-2', 's1-3', rehydrated[3].id])
	assert.match(rehydrated[3].id, /^step_/)
})

test('generateRefinedFlow validates and returns a parsed Flow without saving', async () => {
	const parsed = flowIO.parseFlow(flow([
		{ kind: 'navigate', id: 's0', url: 'https://example.test' },
		{ kind: 'input', id: 's1', target: elementRef(), value: 'hello' },
	]))
	const file = join(tempDir, 'ai-refine-source.json')
	await flowIO.saveFlow(parsed, file)
	const projection = aiRefine.projectFlows([parsed])
	const modelSteps = [
		{
			kind: 'group',
			id: 'g1',
			label: 'Stage 1',
			steps: JSON.parse(projection.flows[0].stepsJson),
		},
	]
	const respond = (payload) => async () => ({ ok: true, text: '```json\n' + JSON.stringify(payload) + '\n```' })

	const ok = await aiRefine.generateRefinedFlow({
		flowFiles: [file],
		runPrompt: respond({ title: 'REFINED test flow', summary: 's', steps: modelSteps, rationale: ['r'], risks: ['k'] }),
	})
	assert.equal(ok.ok, true)
	assert.match(ok.flow.id, /^flow_/)
	assert.equal(ok.flow.steps[0].kind, 'group')
	assert.equal(ok.flow.steps[0].steps[1].target.candidates[0].value, '#target')
	assert.equal(ok.flow.steps[0].steps[1].value, 'hello')
	// 原文件保持原样：生成结果只返回提案，不写回源
	assert.equal((await flowIO.loadFlow(file)).id, parsed.id)

	const failed = await aiRefine.generateRefinedFlow({
		flowFiles: [file],
		runPrompt: respond({ title: 'x', steps: [{ kind: 'click', id: 'c1', target: { observed: {} } }] }),
	})
	assert.equal(failed.ok, false)
	assert.match(failed.error, /inline element data is not allowed/)

	const providerError = await aiRefine.generateRefinedFlow({
		flowFiles: [file],
		runPrompt: async () => ({ ok: false, text: '', error: 'provider down' }),
	})
	assert.equal(providerError.ok, false)
	assert.equal(providerError.error, 'provider down')
})
