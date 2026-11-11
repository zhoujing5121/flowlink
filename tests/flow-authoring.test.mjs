import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'

let tempDir
let flowIO
let planner
let steps

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
	;[flowIO, planner, steps] = await Promise.all([
		bundle('engine/schema/src/io.ts', 'flow-io'),
		bundle('engine/recorder/src/plan.ts', 'plan'),
		bundle('engine/executor/src/steps.ts', 'steps'),
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
