/**
 * AI 细化生成管线（主进程使用，但保持无 Electron 依赖以便测试）。
 *
 * 安全核心：ElementRef（observed 事实、candidates、fingerprint、crop）是录制期
 * 证据，禁止模型改写或捏造。投影（projection）把源步骤里的元素替换为
 * {"$ref":"eN"} 并建立元素库；再水化（rehydration）只允许从库里克隆回填，
 * 内联元素对象一律拒绝。生成结果必须通过 parseFlow 完整校验后才返回，
 * 永不在此模块内落盘。
 */
import {
	loadFlow,
	makeId,
	parseFlow,
	parseTemplate,
	type Assertion,
	type Candidate,
	type ElementRef,
	type Expect,
	type Flow,
	type Step,
	type Variable,
} from '../engine/schema/src/index.js'
import { formatTemplate, type GenerationTemplates } from './prompts.js'

export interface PromptRunner {
	(prompt: string, timeoutMs: number): Promise<{ ok: boolean; text: string; error?: string }>
}

export interface ElementLibraryEntry {
	id: string
	ref: ElementRef
	origin: string
	/** 首见该元素的步骤所在页面 URL；供模型区分登录页/目标页元素 */
	pageUrl?: string
	summary: string
}

export interface ProjectedFlow {
	metadata: string
	stepsJson: string
}

export interface Projection {
	flows: ProjectedFlow[]
	libraryLines: string[]
	library: ElementLibraryEntry[]
}

export type GenerateResult =
	| { ok: true; flow: Flow; title: string; summary: string; rationale: string[]; risks: string[] }
	| { ok: false; error: string }

/** flow 级来源元数据（写入生成结果 meta.sourceFlows；镜像 schema 定义）。 */
export interface FlowSourceMeta {
	recordingId?: string
	flowId: string
	title: string
	flowFile?: string
}

export interface GenerateFlowOptions {
	flowFiles: string[]
	instruction?: string
	conversation?: Array<{ role: string; text: string }>
	timeoutMs?: number
	/** 'auto' = 录制停止后的自动清洗/分组；默认 'refine' 按用户指令生成。 */
	mode?: 'auto' | 'refine'
	/**
	 * 直接来源列表（主进程按 recordingIds + 已加载 flow 构造）。提供时生成结果
	 * 写 meta.sourceFlows，并按元素库 origin 推断每步的 sourceFlowId。
	 * 纯录制/自动清洗（单源 sanitize）不传 → 两个字段都不写。
	 */
	sources?: FlowSourceMeta[]
	/** 生成提示词模板（config/prompts.json 的 generation 段）。 */
	templates: GenerationTemplates
	/**
	 * 修复链路的候选重锚定证据（元素身份键 → source:'ai' 候选）。
	 * 只前插候选、observed/fingerprint 不动；生成结果照常过 parseFlow 契约校验。
	 */
	reanchor?: ReanchorEntry[]
	runPrompt: PromptRunner
}

/* ---------------- 尺寸预算（§2.4）：超限必须明确失败，绝不静默截断 ---------------- */

const LIBRARY_BUDGET = 10_000
const STEPS_BUDGET = 60_000
const CONVERSATION_BUDGET = 12_000
const INSTRUCTION_BUDGET = 4_000
const PROMPT_CAP = 100_000

/* ---------------- 元素库与投影 ---------------- */

function truncateText(value: unknown, max: number): string {
	const text = String(value ?? '')
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** 元素的稳定身份键（fingerprint.stableHash + 首候选）；跨投影重跑保持一致。 */
export function elementKey(ref: ElementRef): string {
	const first = ref.candidates?.[0]
	const value = first
		? typeof first.value === 'string'
			? first.value
			: JSON.stringify(first.value ?? null)
		: ''
	return `${ref.fingerprint?.stableHash ?? ''}\u0000${first?.kind ?? ''}\u0000${value}`
}

function elementSummary(id: string, ref: ElementRef, pageUrl?: string): string {
	const tag = ref.observed?.tag || 'element'
	const name = ref.fingerprint?.accessibleName || ref.observed?.text || ref.description || ''
	const first = ref.candidates?.[0]
	let locator = 'no locator'
	if (first) {
		locator =
			typeof first.value === 'string'
				? `${first.kind} ${truncateText(first.value, 80)}`
				: `${first.kind} ${first.value.role}${first.value.name ? ` "${truncateText(first.value.name, 40)}"` : ''}`
	}
	const fingerprint = ref.fingerprint?.stableHash ? 'fingerprint ok' : 'fingerprint missing'
	const page = pageUrl ? ` · page ${truncateText(pageUrl, 80)}` : ''
	return `${id} · ${tag}${name ? ` "${truncateText(name, 40)}"` : ''} · ${locator} · ${fingerprint}${page}`
}

class LibraryBuilder {
	private library: ElementLibraryEntry[] = []
	private byKey = new Map<string, string>()

	add(ref: ElementRef, origin: string, pageUrl?: string): { $ref: string } {
		const key = elementKey(ref)
		const existing = this.byKey.get(key)
		if (existing) return { $ref: existing }
		const id = `e${this.library.length + 1}`
		this.library.push({
			id,
			ref: structuredClone(ref),
			origin,
			...(pageUrl !== undefined ? { pageUrl } : {}),
			summary: elementSummary(id, ref, pageUrl),
		})
		this.byKey.set(key, id)
		return { $ref: id }
	}

	get entries(): ElementLibraryEntry[] {
		return this.library
	}
}

const BASE_FIELDS = [
	'label',
	'timeout',
	'page',
	'isOptional',
	'pageUrl',
	'systemName',
	'reviewRequired',
	'reviewReason',
	// 执行方式与回放增强字段必须随投影进出：模型看得到才会原样回显，
	// 再水化按未知标量透传——否则每次细化都会把 execution/settle/sourceFlowId 洗掉。
	'execution',
	'settle',
	'sourceFlowId',
]
const STEP_SCALAR_FIELDS: Record<string, string[]> = {
	navigate: ['url', 'navigationType', 'previousUrl'],
	click: ['button', 'clickCount', 'modifiers', 'position'],
	input: ['value', 'clear'],
	select: ['value'],
	key: ['key', 'modifiers'],
	hover: [],
	scroll: ['delta', 'to'],
	drag: [],
	upload: ['files'],
	wait: ['condition', 'ms', 'prompt'],
	assert: ['assertion'],
	condition: ['assertion', 'trueGroupId', 'falseGroupId'],
	extract: ['into', 'prop', 'attr'],
	script: ['code'],
	dialog: ['action', 'promptText'],
	switchTab: ['index'],
	openTab: ['url'],
	closeTab: ['index'],
}

function projectExpect(
	expect: Expect,
	lib: LibraryBuilder,
	where: string,
	pageUrl?: string,
): Record<string, unknown> {
	if (expect.kind === 'urlChange') return { kind: expect.kind, pattern: expect.pattern }
	if (expect.kind === 'domSignature')
		return {
			kind: expect.kind,
			hash: expect.hash,
			...(expect.region !== undefined ? { region: expect.region } : {}),
		}
	if (expect.kind === 'download')
		return {
			kind: expect.kind,
			...(expect.filenamePattern !== undefined ? { filenamePattern: expect.filenamePattern } : {}),
		}
	const out: Record<string, unknown> = {
		kind: expect.kind,
		target: lib.add(expect.target, `${where}.expect.target`, pageUrl),
	}
	if (expect.kind === 'textChange') out.to = expect.to
	return out
}

function projectStep(step: Step, lib: LibraryBuilder, flowId: string): unknown {
	if (!step || typeof step !== 'object') return step
	const source = step as unknown as Record<string, unknown>
	if (step.kind === 'group') {
		return {
			kind: 'group',
			id: step.id,
			label: step.label,
			steps: step.steps.map((child, index) =>
				projectStep(child, lib, `${flowId}/${step.id}.steps[${index}]`),
			),
		}
	}
	const out: Record<string, unknown> = { kind: step.kind, id: step.id }
	for (const field of BASE_FIELDS) if (source[field] !== undefined) out[field] = source[field]
	for (const field of STEP_SCALAR_FIELDS[step.kind] ?? [])
		if (source[field] !== undefined) out[field] = source[field]
	if (source.target !== undefined)
		out.target = lib.add(source.target as ElementRef, `${flowId}/${step.id}.target`, step.pageUrl)
	if (source.from !== undefined)
		out.from = lib.add(source.from as ElementRef, `${flowId}/${step.id}.from`, step.pageUrl)
	if (source.to !== undefined && typeof source.to === 'object') {
		const to = { ...(source.to as Record<string, unknown>) }
		if (to.target !== undefined)
			to.target = lib.add(to.target as ElementRef, `${flowId}/${step.id}.to.target`, step.pageUrl)
		out.to = to
	}
	if (source.expect !== undefined && source.expect !== null) {
		out.expect = projectExpect(source.expect as Expect, lib, `${flowId}/${step.id}`, step.pageUrl)
	}
	return out
}

/**
 * 把多个 Flow 投影为紧凑步骤 + 共享元素库。步骤或元素库超出预算时立即抛出
 * 面向用户的错误（“拆分流程”），绝不静默截断。
 */
export function projectFlows(flows: Flow[]): Projection {
	const lib = new LibraryBuilder()
	const projected: ProjectedFlow[] = flows.map((flow) => ({
		metadata: JSON.stringify({
			id: flow.id,
			title: flow.title,
			meta: flow.meta,
			variables: flow.variables ?? [],
		}),
		stepsJson: JSON.stringify(flow.steps.map((step, index) => projectStep(step, lib, `${flow.id}#steps[${index}]`))),
	}))
	const libraryLines = lib.entries.map((entry) => entry.summary)
	const libraryText = libraryLines.join('\n')
	if (libraryText.length > LIBRARY_BUDGET) {
		throw new Error(
			`The element library is too large to refine in one pass (${libraryText.length} characters); split the flow or remove steps.`,
		)
	}
	const stepsText = projected.map((flow) => flow.stepsJson).join('\n')
	if (stepsText.length > STEPS_BUDGET) {
		throw new Error(
			`The flow is too large to refine in one pass (${stepsText.length} characters of steps); split it or remove steps.`,
		)
	}
	return { flows: projected, libraryLines, library: lib.entries }
}

/* ---------------- JSON 提取 ---------------- */

function firstBalancedObject(text: string): string | undefined {
	const start = text.indexOf('{')
	if (start < 0) return undefined
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < text.length; i++) {
		const ch = text[i]
		if (inString) {
			if (escaped) escaped = false
			else if (ch === '\\') escaped = true
			else if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) return text.slice(start, i + 1)
		}
	}
	return undefined
}

/** 从模型文本中提取唯一 JSON 对象：先试整体/围栏代码块，再退回括号配对扫描。 */
export function extractJsonObject(text: string): unknown {
	const raw = String(text ?? '').trim()
	if (!raw) throw new Error('Pi returned an empty response')
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	const candidates: string[] = []
	if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim())
	candidates.push(raw)
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate)
		} catch {
			const scanned = firstBalancedObject(candidate)
			if (scanned !== undefined) {
				try {
					return JSON.parse(scanned)
				} catch {
					/* 尝试下一个候选 */
				}
			}
		}
	}
	throw new Error(
		'Pi did not return valid JSON for the refined material. The source was left unchanged. Ask Pi to retry with valid JSON.',
	)
}

/* ---------------- 再水化：唯一允许元素证据进入输出的路径 ---------------- */

function resolveRef(
	value: unknown,
	byId: Map<string, ElementRef>,
	where: string,
): ElementRef {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		const refId = record.$ref
		if (typeof refId === 'string' && Object.keys(record).every((key) => key === '$ref')) {
			const entry = byId.get(refId)
			if (!entry) throw new Error(`${where}: unknown element reference "${refId}"`)
			return structuredClone(entry)
		}
	}
	throw new Error(
		`${where}: inline element data is not allowed; reference the element library via {"$ref": "eN"}`,
	)
}

function rehydrateExpect(
	expect: unknown,
	byId: Map<string, ElementRef>,
	where: string,
): Record<string, unknown> {
	if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
		throw new Error(`${where}: expect must be an object`)
	}
	const source = expect as Record<string, unknown>
	const out: Record<string, unknown> = { ...structuredClone(source) }
	if ('target' in source) out.target = resolveRef(source.target, byId, `${where}.target`)
	return out
}

export interface RehydrateHooks {
	/**
	 * 每个步骤再水化完成时回调一次（组节点不回调）。
	 * refIds = 该步骤通过 {"$ref":"eN"} 引用的全部元素库 id（target/from/to/expect），
	 * 供调用方按元素库 origin 推断步骤级来源（sourceFlowId）。
	 */
	onStepRefs?: (step: Record<string, unknown>, refIds: string[]) => void
}

/**
 * 把模型输出步骤再水化为可校验步骤：元素字段只接受 {"$ref":"eN"}；缺失 id 补
 * 生成；冲突 id 依次加 -2/-3 后缀（组 id 与步骤 id 共用一个命名空间）。
 */
export function rehydrateSteps(
	steps: unknown,
	library: ElementLibraryEntry[],
	hooks: RehydrateHooks = {},
): Step[] {
	const byId = new Map(library.map((entry) => [entry.id, entry.ref]))
	const seenIds = new Set<string>()
	const uniqueId = (raw: unknown): string => {
		const base = typeof raw === 'string' && raw.trim() ? raw.trim() : makeId('step')
		if (!seenIds.has(base)) {
			seenIds.add(base)
			return base
		}
		let suffix = 2
		let next = `${base}-${suffix}`
		while (seenIds.has(next)) {
			suffix++
			next = `${base}-${suffix}`
		}
		seenIds.add(next)
		return next
	}
	const walk = (value: unknown, where: string): Record<string, unknown> => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`${where}: step must be an object`)
		}
		const source = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const [key, val] of Object.entries(source)) {
			if (key === 'target' || key === 'from' || key === 'to' || key === 'expect' || key === 'id') continue
			out[key] = structuredClone(val)
		}
		out.id = uniqueId(source.id)
		const refIds: string[] = []
		const resolveTracked = (raw: unknown, at: string): ElementRef => {
			const record = raw as Record<string, unknown>
			if (record && typeof record === 'object' && typeof record.$ref === 'string') refIds.push(record.$ref)
			return resolveRef(raw, byId, at)
		}
		if ('target' in source)
			out.target = resolveTracked(source.target, `${where}(id=${out.id}).target`)
		if ('from' in source)
			out.from = resolveTracked(source.from, `${where}(id=${out.id}).from`)
		if ('to' in source) {
			if (!source.to || typeof source.to !== 'object' || Array.isArray(source.to)) {
				throw new Error(`${where}(id=${out.id}).to: must be an object`)
			}
			const to = { ...structuredClone(source.to as Record<string, unknown>) }
			if ('target' in (source.to as Record<string, unknown>)) {
				to.target = resolveTracked(
					(source.to as Record<string, unknown>).target,
					`${where}(id=${out.id}).to.target`,
				)
			}
			out.to = to
		}
		if (source.expect !== undefined && source.expect !== null) {
			// expect 内层 target 的 refId 也计入步骤来源投票
			const expectSource = source.expect as Record<string, unknown>
			if (
				expectSource &&
				typeof expectSource === 'object' &&
				'target' in expectSource &&
				expectSource.target &&
				typeof expectSource.target === 'object' &&
				typeof (expectSource.target as Record<string, unknown>).$ref === 'string'
			) {
				refIds.push((expectSource.target as Record<string, unknown>).$ref as string)
			}
			out.expect = rehydrateExpect(source.expect, byId, `${where}(id=${out.id}).expect`)
		}
		if (Array.isArray(source.steps)) {
			out.steps = (source.steps as unknown[]).map((child, index) =>
				walk(child, `${where}.steps[${index}]`),
			)
		}
		hooks.onStepRefs?.(out, refIds)
		return out
	}
	if (!Array.isArray(steps) || !steps.length) {
		throw new Error('Pi returned no executable steps; the source was left unchanged.')
	}
	return steps.map((step, index) => walk(step, `steps[${index}]`)) as Step[]
}

/* ---------------- 候选重锚定（受控通道：不让模型发明选择器） ---------------- */

/** 一条重锚定证据：元素身份键 → 来自接管证据的新候选（source:'ai'）。 */
export interface ReanchorEntry {
	key: string
	candidates: Candidate[]
}

function sameCandidate(a: Candidate, b: Candidate): boolean {
	return (
		a.kind === b.kind &&
		JSON.stringify(a.value) === JSON.stringify(b.value)
	)
}

function prependCandidates(ref: ElementRef, extra: Candidate[]): ElementRef {
	if (!extra.length || !ref.candidates?.length) return ref
	const head = Math.min(...ref.candidates.map((candidate) => candidate.score))
	const additions = extra
		.map((candidate) => ({ ...candidate, score: head, source: 'ai' as const }))
		.filter((candidate) => !ref.candidates!.some((existing) => sameCandidate(existing, candidate)))
	if (!additions.length) return ref
	// 只前插 source:'ai' 候选；score 取现有最小值保持升序（parseFlow 契约校验兜底），
	// observed/fingerprint 不动——旧候选链完整保留，回放定位能力不因误报而丢失。
	return { ...ref, candidates: [...additions, ...ref.candidates!] }
}

/**
 * 修复输出重锚定：仅当修复链路携带 reanchor 证据时，把「库元素 → 新候选」前插进
 * 对应步骤的元素引用（target/from/to.target/expect.target）。证据键由主进程按
 * 源流程元素身份计算（elementKey），再水化克隆不改变键值，可稳定对上。
 */
export function applyReanchor(steps: Step[], entries: ReanchorEntry[]): Step[] {
	if (!entries.length) return steps
	const byKey = new Map(entries.map((entry) => [entry.key, entry.candidates]))
	const reanchorRef = (ref: ElementRef): ElementRef => {
		const extra = byKey.get(elementKey(ref))
		return extra ? prependCandidates(ref, extra) : ref
	}
	const walk = (step: Step): Step => {
		if (step.kind === 'group') {
			return { ...step, steps: step.steps.map(walk) }
		}
		const out: Record<string, unknown> = { ...structuredClone(step) }
		const source = step as unknown as Record<string, unknown>
		if (source.target !== undefined) out.target = reanchorRef(source.target as ElementRef)
		if (source.from !== undefined) out.from = reanchorRef(source.from as ElementRef)
		if (source.to && typeof source.to === 'object') {
			const to = { ...(source.to as Record<string, unknown>) }
			if (to.target !== undefined) to.target = reanchorRef(to.target as ElementRef)
			out.to = to
		}
		const expect = source.expect as { target?: ElementRef } | undefined
		if (expect && typeof expect === 'object' && expect.target !== undefined) {
			out.expect = { ...expect, target: reanchorRef(expect.target) }
		}
		return out as unknown as Step
	}
	return steps.map(walk)
}

/* ---------------- 变量合并 ---------------- */

const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const VARIABLE_TYPES = ['string', 'text', 'email', 'date', 'number', 'secret', 'file'] as const

/**
 * 合并所有源 Flow 的变量：首个非 secret 默认值生效（按源顺序）。模型若额外
 * 输出 variables，只接受合法命名且非 secret 的条目。
 */
export function mergeVariables(flows: Flow[], piVariables?: unknown): Variable[] {
	const merged = new Map<string, Variable>()
	const add = (variable: Variable): void => {
		const existing = merged.get(variable.name)
		if (!existing) {
			merged.set(variable.name, { ...variable })
			return
		}
		if (!existing.defaultValue && variable.defaultValue && !variable.secret && !existing.secret) {
			merged.set(variable.name, { ...existing, defaultValue: variable.defaultValue })
		}
	}
	for (const flow of flows) for (const variable of flow.variables ?? []) add(variable)
	if (Array.isArray(piVariables)) {
		for (const entry of piVariables) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
			const candidate = entry as Record<string, unknown>
			const name = candidate.name
			if (typeof name !== 'string' || !VARIABLE_NAME_RE.test(name)) continue
			if (candidate.secret === true) continue
			const type = VARIABLE_TYPES.includes(candidate.type as (typeof VARIABLE_TYPES)[number])
				? (candidate.type as Variable['type'])
				: 'string'
			add({
				name,
				type,
				defaultValue: typeof candidate.defaultValue === 'string' ? candidate.defaultValue : undefined,
				secret: false,
				source: candidate.source === 'csv' ? 'csv' : 'input',
			})
		}
	}
	return [...merged.values()]
}

/**
 * 收集输出步骤引用/定义的全部模板变量名（生成后置守卫的数据源）。
 * - defined：extract 步骤的 into —— 运行时变量，必须排除在"未定义引用"校验外，
 *   否则 `{{运行时变量}}` 会被误报为引用了不存在的录制变量；
 * - used：所有值携带字段里的 {{name}} 引用；模板语法非法让 parseTemplate 抛错，
 *   生成整体失败（绝不静默吞掉）。
 */
export function collectTemplateRefs(steps: Step[]): { used: Set<string>; defined: Set<string> } {
	const used = new Set<string>()
	const defined = new Set<string>()
	const use = (value: string | undefined): void => {
		if (value === undefined) return
		for (const name of parseTemplate(value)) used.add(name)
	}
	const visitAssertion = (assertion: Assertion): void => {
		if (assertion.kind === 'text') {
			use(assertion.equals)
			use(assertion.contains)
		} else if (assertion.kind === 'value') {
			use(assertion.equals)
		}
	}
	const visit = (step: Step): void => {
		if (step.kind === 'group') {
			for (const child of step.steps) visit(child)
			return
		}
		if (step.kind === 'input') use(step.value)
		else if (step.kind === 'select') {
			if (typeof step.value === 'string') use(step.value)
			else for (const item of step.value) use(item)
		} else if (step.kind === 'upload') {
			for (const file of step.files) use(file)
		} else if (step.kind === 'dialog') use(step.promptText)
		else if (step.kind === 'navigate') use(step.url)
		else if (step.kind === 'wait') use(step.prompt)
		else if (step.kind === 'key') use(step.key)
		if (step.kind === 'assert' || step.kind === 'condition') visitAssertion(step.assertion)
		if (step.kind === 'extract') defined.add(step.into)
		if (step.expect?.kind === 'urlChange') use(step.expect.pattern)
		if (step.expect?.kind === 'textChange') use(step.expect.to)
	}
	for (const step of steps) visit(step)
	return { used, defined }
}

/* ---------------- 提示词组装（模板来自 config/prompts.json） ---------------- */

export function buildAutoSanitizePrompt(
	flow: Flow,
	projection: Projection,
	template: string,
): string {
	return formatTemplate(template, {
		metadata:
			projection.flows[0]?.metadata ?? JSON.stringify({ id: flow.id, title: flow.title }),
		library: projection.libraryLines.join('\n') || '(empty)',
		steps: projection.flows[0]?.stepsJson ?? '[]',
	})
}

function conversationSection(
	conversation: Array<{ role: string; text: string }> | undefined,
): string {
	const turns = (conversation ?? []).filter(
		(turn) => turn && (typeof turn.text === 'string' || typeof turn.role === 'string'),
	)
	const kept: Array<{ role: string; text: string }> = []
	let budget = CONVERSATION_BUDGET
	for (let index = turns.length - 1; index >= 0 && turns.length - index <= 8; index--) {
		const turn = turns[index]
		const text = String(turn.text ?? '').slice(0, Math.max(0, budget))
		const line = { role: String(turn.role ?? 'user'), text }
		const cost = JSON.stringify(line).length
		if (cost > budget) break
		budget -= cost
		kept.unshift(line)
	}
	if (!kept.length) return '(none)'
	return JSON.stringify(kept)
}

export function buildRefinePrompt(
	flows: Flow[],
	projection: Projection,
	instruction: string | undefined,
	conversation: Array<{ role: string; text: string }> | undefined,
	template: string,
): string {
	const rawInstruction = String(instruction ?? '').trim()
	const boundedInstruction =
		rawInstruction.length > INSTRUCTION_BUDGET
			? `${rawInstruction.slice(0, INSTRUCTION_BUDGET)} (truncated)`
			: rawInstruction || '(no additional instruction; sanitize and group the sources)'
	const stepSections = projection.flows
		.map((flow, index) => `--- Flow ${index + 1} steps ---\n${flow.stepsJson}`)
		.join('\n')
	return formatTemplate(template, {
		flowCount: String(flows.length),
		instruction: boundedInstruction,
		conversation: conversationSection(conversation),
		metadata: projection.flows.map((flow) => flow.metadata).join('\n'),
		library: projection.libraryLines.join('\n') || '(empty)',
		stepSections,
	})
}

/* ---------------- 生成入口（不落盘） ---------------- */

/**
 * 步骤级来源推断（启发式，非精确科学）：
 * 1. 每步取其全部 $ref 元素的库条目 origin（格式 `${flowId}#...`），
 *    出现最多的 flowId 记为该步 sourceFlowId；
 * 2. 无元素引用的步骤（navigate/wait 等）向前继承最近一个已标注步骤，
 *    首步无前驱时向后继承第一个标注——AI 融合的段边界通常有元素引用可依。
 */
function annotateSourceFlowIds(
	steps: Step[],
	library: ElementLibraryEntry[],
	refIdsByStep: Map<Record<string, unknown>, string[]>,
): void {
	const originFlowOf = new Map<string, string | undefined>()
	for (const entry of library) {
		if (!originFlowOf.has(entry.id)) originFlowOf.set(entry.id, entry.origin.split('#')[0])
	}
	const ordered: Array<{ step: Record<string, unknown>; source?: string }> = []
	const visit = (list: Step[]): void => {
		for (const step of list) {
			if (step.kind === 'group') visit(step.steps)
			else ordered.push({ step: step as unknown as Record<string, unknown> })
		}
	}
	visit(steps)
	for (const entry of ordered) {
		const votes = new Map<string, number>()
		for (const refId of refIdsByStep.get(entry.step) ?? []) {
			const flowId = originFlowOf.get(refId)
			if (flowId) votes.set(flowId, (votes.get(flowId) ?? 0) + 1)
		}
		if (votes.size > 0) {
			entry.source = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0]
		}
	}
	if (!ordered.some((entry) => entry.source)) return
	// 向前填充；首段无前驱 → 向后继承第一个标注
	let carry: string | undefined
	for (const entry of ordered) {
		if (entry.source) carry = entry.source
		else if (carry) entry.source = carry
	}
	const firstLabeled = ordered.find((entry) => entry.source)!.source
	for (const entry of ordered) {
		if (!entry.source) entry.source = firstLabeled
		entry.step.sourceFlowId = entry.source
	}
}

export async function generateRefinedFlow(options: GenerateFlowOptions): Promise<GenerateResult> {
	try {
		if (!Array.isArray(options.flowFiles) || !options.flowFiles.length) {
			throw new Error('No source flows were selected for refinement.')
		}
		if (typeof options.runPrompt !== 'function') {
			throw new Error('A Pi prompt runner is required to generate a refined flow.')
		}
		const flows: Flow[] = []
		for (const file of options.flowFiles) flows.push(await loadFlow(file))
		const projection = projectFlows(flows)
		if (!options.templates?.autoSanitize || !options.templates?.refine) {
			throw new Error('Pi generation prompt templates are required (config/prompts.json).')
		}
		const prompt =
			options.mode === 'auto'
				? buildAutoSanitizePrompt(flows[0]!, projection, options.templates.autoSanitize)
				: buildRefinePrompt(
						flows,
						projection,
						options.instruction,
						options.conversation,
						options.templates.refine,
					)
		if (prompt.length > PROMPT_CAP) {
			throw new Error(
				`The refinement prompt is too large (${prompt.length} characters); split the flow or remove steps.`,
			)
		}
		const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 180_000, 600_000))
		const result = await options.runPrompt(prompt, timeoutMs)
		if (!result.ok) throw new Error(result.error || 'Pi agent request failed')

		const parsed = extractJsonObject(result.text) as Record<string, unknown>
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Pi response is not a JSON object; the source was left unchanged.')
		}
		const refIdsByStep = new Map<Record<string, unknown>, string[]>()
		let steps = rehydrateSteps(parsed.steps, projection.library, {
			onStepRefs: (step, refIds) => refIdsByStep.set(step, refIds),
		})
		// 受控重锚定：修复证据命中库元素 → 前插 source:'ai' 候选（observed 不动）。
		if (options.reanchor?.length) steps = applyReanchor(steps, options.reanchor)
		const sources = options.sources?.length ? options.sources : undefined
		if (sources) annotateSourceFlowIds(steps, projection.library, refIdsByStep)
		const variables = mergeVariables(flows, parsed.variables)
		// 参数保护守卫（不依赖模型自觉）：
		// 1) 引用了不存在的变量 → 整次生成失败（源流程不动，与现有错误路径一致）；
		// 2) 剪除输出中不再被引用的变量，避免 Reference 页出现死参数；
		// 3) 源流程有 secret 变量而输出不再使用 → 追加一条 risk。
		const { used, defined } = collectTemplateRefs(steps)
		for (const name of used) {
			if (!defined.has(name) && !variables.some((v) => v.name === name)) {
				throw new Error(`生成的步骤引用了不存在的变量 {{${name}}}；源流程未改动`)
			}
		}
		const usedOrDefined = new Set([...used, ...defined])
		const prunedVariables = variables.filter((v) => usedOrDefined.has(v.name))
		const secretDropped =
			flows.some((f) => (f.variables ?? []).some((v) => v.secret)) &&
			!prunedVariables.some((v) => v.secret)
		const rawTitle =
			typeof parsed.title === 'string' && parsed.title.trim()
				? parsed.title.trim()
				: `Refined ${flows[0]!.title}`
		const title = /^REFINED\b/i.test(rawTitle) ? rawTitle : `REFINED ${rawTitle}`
		const flow = parseFlow(
			{
				...flows[0]!,
				id: makeId('flow'),
				version: 1,
				createdAt: new Date().toISOString(),
				title,
				// 来源元数据：直接来源（不递归展开）；从 REFINED 再细化时同样只记
				// 本次的直接源，transitive 可按 flowId 沿各源 flow 的 meta 追溯。
				...(sources ? { meta: { ...flows[0]!.meta, sourceFlows: sources } } : {}),
				steps,
				variables: prunedVariables,
				stats: undefined,
				selfHealed: [],
			},
			'<ai-refine>',
		)
		return {
			ok: true,
			flow,
			title,
			summary: typeof parsed.summary === 'string' ? parsed.summary : '',
			rationale: Array.isArray(parsed.rationale)
				? parsed.rationale.filter((item): item is string => typeof item === 'string')
				: [],
			risks: [
				...(Array.isArray(parsed.risks)
					? parsed.risks.filter((item): item is string => typeof item === 'string')
					: []),
				...(secretDropped
					? [
							'源流程包含密码变量 {{password}}，但生成结果不再引用它：凭据步骤可能被删除，请人工确认登录段是否完整',
						]
					: []),
			],
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
