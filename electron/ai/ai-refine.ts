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
} from '../../engine/schema/src/index.js'
import { formatTemplate, type GenerationTemplates } from './prompts.js'
import { appLog, appLogFields } from '../infra/app-logger.js'
import { mapLegacyType } from '../../engine/reference/src/index.js'

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

/** 生成结果的执行方式判定条目（报告面：AI 面板展示与复核用，不参与校验）。 */
export interface ExecutionDecision {
	stepId: string
	execution: 'automated' | 'manual'
	reason: string
	/** 0-1 提示值，仅辅助人工复核，绝不作为自动放行阈值。 */
	confidence?: number
	requiredCapabilities?: string[]
	unresolvedQuestions?: string[]
}

export type GenerateResult =
	| { ok: true; flow: Flow; title: string; summary: string; rationale: string[]; risks: string[]; executionDecisions: ExecutionDecision[] }
	| { ok: false; error: string; detail: { stage: string; reason: string } }

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
	condition: ['assertion', 'trueStepId', 'falseStepId'],
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

/**
 * 合并所有源 Flow 的变量：首个非 secret 默认值生效（按源顺序）。模型若额外
 * 输出 variables，只接受合法命名且非 secret 的条目（type 经旧→新目录归一）。
 * 模型输出的 variableLabels（[{name, label}]）在此合并：未知机器键整次拒绝
 * （与后置守卫「引用了不存在的变量」同一报错面），非空 label 覆盖启发式/旧值；
 * 其余 Reference 元数据（必填/校验/活动关联）不来自模型、按源 Flow 保留。
 */
export function mergeVariables(
	flows: Flow[],
	piVariables?: unknown,
	piVariableLabels?: unknown,
	piVariableRules?: unknown,
): Variable[] {
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
			const defaultValue = typeof candidate.defaultValue === 'string' ? candidate.defaultValue : undefined
			const type = typeof candidate.type === 'string'
				? mapLegacyType(candidate.type, defaultValue).type
				: 'string'
			add({
				name,
				type,
				defaultValue,
				secret: false,
				source: candidate.source === 'csv' ? 'csv' : 'input',
			})
		}
	}
	if (piVariableLabels !== undefined) {
		if (!Array.isArray(piVariableLabels)) {
			throw new Error('variableLabels 必须是 [{name, label}] 数组')
		}
		for (const entry of piVariableLabels) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				throw new Error('variableLabels 条目必须是 {name, label} 对象')
			}
			const { name, label } = entry as Record<string, unknown>
			if (typeof name !== 'string' || !VARIABLE_NAME_RE.test(name)) {
				throw new Error(`variableLabels 的变量名无效：${JSON.stringify(name)}`)
			}
			const target = merged.get(name)
			if (!target) {
				throw new Error(`生成的 variableLabels 引用了不存在的变量 {{${name}}}；源流程未改动`)
			}
			if (typeof label === 'string' && label.trim()) {
				merged.set(name, { ...target, label: label.trim() })
			}
		}
	}
	if (piVariableRules !== undefined) {
		if (!Array.isArray(piVariableRules)) {
			throw new Error('variableRules 必须是 [{name, rules}] 数组')
		}
		for (const entry of piVariableRules) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				throw new Error('variableRules 条目必须是 {name, rules} 对象')
			}
			const { name, rules } = entry as Record<string, unknown>
			if (typeof name !== 'string' || !VARIABLE_NAME_RE.test(name)) {
				throw new Error(`variableRules 的变量名无效：${JSON.stringify(name)}`)
			}
			const target = merged.get(name)
			if (!target) {
				throw new Error(`生成的 variableRules 引用了不存在的变量 {{${name}}}；源流程未改动`)
			}
			if (typeof rules === 'string' && rules.trim()) {
				merged.set(name, { ...target, rules: rules.trim() })
			}
		}
	}
	return [...merged.values()]
}

/* ---------------- 活动关联：使用证据推导 + AI 建议补空（修订轮 D8） ---------------- */

/**
 * 解析模型 variableActivities 建议表：[{name, activities: [groupId]}]。
 * 未知机器键整次拒绝（与 variableLabels 同一报错面）；条目形状非法也拒绝。
 * 未知分组 id 不在此拒——留待按新材料真实分组剔除。
 */
export function parseVariableActivities(
	raw: unknown,
	knownNames: ReadonlySet<string>,
): Map<string, string[]> {
	const out = new Map<string, string[]>()
	if (raw === undefined) return out
	if (!Array.isArray(raw)) throw new Error('variableActivities 必须是 [{name, activities}] 数组')
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error('variableActivities 条目必须是 {name, activities: [groupId]} 对象')
		}
		const { name, activities } = entry as Record<string, unknown>
		if (typeof name !== 'string' || !VARIABLE_NAME_RE.test(name)) {
			throw new Error(`variableActivities 的变量名无效：${JSON.stringify(name)}`)
		}
		if (!knownNames.has(name)) {
			throw new Error(`生成的 variableActivities 引用了不存在的变量 {{${name}}}；源流程未改动`)
		}
		if (!Array.isArray(activities) || !activities.every((id) => typeof id === 'string' && id)) {
			throw new Error(`variableActivities[${name}] 的 activities 必须是非空字符串数组`)
		}
		out.set(name, activities as string[])
	}
	return out
}

/** 收集一条字符串值里的 {{name}}（模板语法非法时跳过该字段，防御） */
function templateNamesIn(value: unknown): string[] {
	if (typeof value !== 'string') return []
	try {
		return parseTemplate(value)
	} catch {
		return []
	}
}

/**
 * 使用证据推导：变量模板出现在哪些顶层分组的步骤中 → 该变量默认关联哪些分组
 * （多处即多选）。顶层裸步骤（不属于任何分组）不产生关联；组内递归收集。
 */
export function deriveVariableActivities(
	variables: ReadonlyArray<Variable>,
	steps: ReadonlyArray<Step>,
): Map<string, string[]> {
	const evidence = new Map<string, Set<string>>()
	const noteNames = (names: string[], groupId: string): void => {
		for (const name of names) {
			if (!evidence.has(name)) evidence.set(name, new Set())
			evidence.get(name)!.add(groupId)
		}
	}
	const collectStep = (step: Step, groupId: string): void => {
		const names: string[] = []
		switch (step.kind) {
			case 'navigate':
				names.push(...templateNamesIn(step.url))
				break
			case 'input':
				names.push(...templateNamesIn(step.value))
				break
			case 'select':
				if (typeof step.value === 'string') names.push(...templateNamesIn(step.value))
				else for (const item of step.value) names.push(...templateNamesIn(item))
				break
			case 'upload':
				for (const file of step.files) names.push(...templateNamesIn(file))
				break
			case 'dialog':
				names.push(...templateNamesIn(step.promptText))
				break
			case 'wait':
				names.push(...templateNamesIn(step.prompt))
				break
			case 'key':
				names.push(...templateNamesIn(step.key))
				break
			default:
				break
		}
		if (step.kind === 'assert' || step.kind === 'condition') {
			if (step.assertion.kind === 'text') {
				names.push(...templateNamesIn(step.assertion.equals), ...templateNamesIn(step.assertion.contains))
			} else if (step.assertion.kind === 'value') {
				names.push(...templateNamesIn(step.assertion.equals))
			}
		}
		if (step.expect?.kind === 'urlChange') names.push(...templateNamesIn(step.expect.pattern))
		if (step.expect?.kind === 'textChange') names.push(...templateNamesIn(step.expect.to))
		noteNames(names, groupId)
	}
	const walkGroup = (list: ReadonlyArray<Step>, groupId: string): void => {
		for (const step of list) {
			if (step.kind === 'group') walkGroup(step.steps, groupId)
			else collectStep(step, groupId)
		}
	}
	for (const step of steps) {
		if (step.kind === 'group') walkGroup(step.steps, step.id)
	}
	const out = new Map<string, string[]>()
	for (const variable of variables) {
		const ids = evidence.get(variable.name)
		if (ids && ids.size) out.set(variable.name, [...ids])
	}
	return out
}

/**
 * 应用活动关联默认值（新材料落盘前）：
 * 1) 清除自源 Flow 继承的分组 id（新材料分组结构不同，旧 id 悬空）；
 * 2) 使用证据推导优先（变量模板出现在哪些 L1 分组即关联哪些）；
 * 3) 无使用证据的变量用模型建议填充（钳制到新材料真实存在的分组 id，未知剔除不拒）。
 */
export function applyActivityDefaults(
	variables: Variable[],
	steps: ReadonlyArray<Step>,
	suggestions: ReadonlyMap<string, string[]>,
): Variable[] {
	const evidence = deriveVariableActivities(variables, steps)
	const topLevelGroupIds = new Set(
		steps.filter((step): step is Extract<Step, { kind: 'group' }> => step.kind === 'group').map((step) => step.id),
	)
	return variables.map((variable) => {
		const evidenceIds = evidence.get(variable.name) ?? []
		const suggested = evidenceIds.length ? evidenceIds : (suggestions.get(variable.name) ?? [])
		const activities = suggested.filter((id) => topLevelGroupIds.has(id))
		return activities.length ? { ...variable, activities } : { ...variable, activities: undefined }
	})
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
	const visitAssertion = (assertion: Assertion | undefined): void => {
		if (!assertion) return
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

/** assert/condition 缺断言定义时整步丢弃（模型增强步骤非录制证据），返回剩余步骤与风险说明。 */
export function dropStepsWithoutAssertion(steps: Step[]): { steps: Step[]; dropped: string[] } {
	const dropped: string[] = []
	const visit = (list: Step[]): Step[] => {
		const out: Step[] = []
		for (const step of list) {
			if (step.kind === 'group') {
				out.push({ ...step, steps: visit(step.steps) })
				continue
			}
			if ((step.kind === 'assert' || step.kind === 'condition') && !step.assertion) {
				dropped.push(`模型输出的校验步骤 ${step.id} 缺少断言定义，已移除`)
				continue
			}
			out.push(step)
		}
		return out
	}
	return { steps: visit(steps), dropped }
}

/* ---------------- 执行方式归一（manual/automated 判定的后置守卫） ---------------- */

/** 自带执行语义、不参与 manual 标记的步骤类型（manual 分支会抢先于其原生处理）。 */
const NON_MANUAL_KINDS = new Set(['wait', 'assert', 'condition', 'dialog', 'script'])

/**
 * 执行方式归一：提示词已要求模型逐步判定，这里做参数保护守卫（不依赖模型自觉）。
 * - wait/assert/condition/dialog/script 强制清除 execution；
 * - 动作步骤缺失/非法（大小写容错）→ 回落 manual（保守：宁可人工执行）并聚合一条 risk；
 * - executionDecisions sidecar 只做报告面：字段残缺或与输出步骤对不上（再水化可能改写
 *   冲突 id）的条目降级并入 risks，理由不丢。
 */
export function normalizeExecutionModes(steps: Step[], decisions: unknown): {
	decisions: ExecutionDecision[]
	risks: string[]
} {
	const risks: string[] = []
	const labelOf = (step: Step): string => step.label ?? step.id
	const missing: string[] = []
	const visit = (list: Step[]): void => {
		for (const step of list) {
			if (step.kind === 'group') {
				visit(step.steps)
				continue
			}
			const record = step as Record<string, unknown>
			const raw = record.execution
			if (NON_MANUAL_KINDS.has(step.kind)) {
				if (raw !== undefined) delete record.execution
			} else if (typeof raw === 'string') {
				const lowered = raw.trim().toLowerCase()
				if (lowered === 'manual' || lowered === 'automated') {
					if (raw !== lowered) record.execution = lowered
				} else {
					record.execution = 'manual'
					risks.push(`步骤「${labelOf(step)}」的执行方式输出非法（${raw}），已回落为人工执行（manual），请复核`)
				}
			} else {
				record.execution = 'manual'
				missing.push(labelOf(step))
			}
		}
	}
	visit(steps)
	if (missing.length) {
		risks.push(
			`有 ${missing.length} 个步骤未输出执行方式，已默认人工执行（manual）：` +
				missing.slice(0, 8).join('、') +
				(missing.length > 8 ? ' 等' : ''),
		)
	}

	const known = new Set<string>()
	const collect = (list: Step[]): void => {
		for (const step of list) {
			if (step.kind === 'group') collect(step.steps)
			else known.add(step.id)
		}
	}
	collect(steps)
	const out: ExecutionDecision[] = []
	if (Array.isArray(decisions)) {
		for (const entry of decisions) {
			const source = entry as Record<string, unknown>
			const stepId = typeof source?.stepId === 'string' ? source.stepId : ''
			const rawMode = typeof source?.execution === 'string' ? source.execution.trim().toLowerCase() : ''
			const reason = typeof source?.reason === 'string' ? source.reason.trim() : ''
			if (!stepId || (rawMode !== 'manual' && rawMode !== 'automated') || !reason || !known.has(stepId)) {
				const brief = reason ? `：${reason}` : ''
				risks.push(`执行方式判定条目无法匹配输出步骤（stepId=${stepId || '(缺失)'}）${brief}`)
				continue
			}
			out.push({
				stepId,
				execution: rawMode,
				reason,
				...(typeof source.confidence === 'number' && Number.isFinite(source.confidence)
					? { confidence: Math.min(1, Math.max(0, source.confidence)) }
					: {}),
				...(Array.isArray(source.requiredCapabilities)
					? { requiredCapabilities: source.requiredCapabilities.filter((v): v is string => typeof v === 'string') }
					: {}),
				...(Array.isArray(source.unresolvedQuestions)
					? { unresolvedQuestions: source.unresolvedQuestions.filter((v): v is string => typeof v === 'string') }
					: {}),
			})
		}
	}
	return { decisions: out, risks }
}

/**
 * 生成输出的嵌套多级结构契约（add-multilevel-grouping）：
 * - 顶层必须全部是 L1 业务级分组，数量 2–6；
 * - 分组嵌套至多两层（L1 内含 L2），步骤只出现在 L1/L2 之内（输出深度 ≤3 级）；
 * - 分组 label 必填非空；targetSystem 可选，出现时必须是字符串（证据不足应省略）；
 * - 空分组拒绝。畸形即败（不产半成品），问题逐项列出。
 */
export function validateGenerationStructure(steps: Step[]): string[] {
	const errors: string[] = []
	const topGroups = steps.filter((step) => step?.kind === 'group')
	const bareCount = steps.length - topGroups.length
	if (bareCount > 0)
		errors.push(`顶层存在 ${bareCount} 个未分组步骤（顶层必须全部是 L1 业务级分组）`)
	if (topGroups.length < 2 || topGroups.length > 6)
		errors.push(`顶层分组数量 ${topGroups.length} 超出契约（L1 业务级分组必须 2–6 个）`)
	const visit = (list: Step[], depth: number, where: string): void => {
		for (let i = 0; i < list.length; i++) {
			const step = list[i]!
			const at = `${where}[${i}]`
			if (step.kind !== 'group') continue
			if (typeof step.label !== 'string' || !step.label.trim())
				errors.push(`${at}: 分组 label 必填（非空字符串）`)
			if (step.targetSystem !== undefined && typeof step.targetSystem !== 'string')
				errors.push(`${at}: targetSystem 必须是字符串（证据不足应省略字段）`)
			if (step.steps.length === 0)
				errors.push(`${at}: 空分组被拒绝（group "${step.id}" 无任何步骤）`)
			if (depth >= 2) {
				errors.push(`${at}: 分组嵌套超出 3 级（L1 > L2 > 步骤 已是最深层）`)
				continue
			}
			visit(step.steps, depth + 1, `${at}.steps`)
		}
	}
	visit(steps, 0, 'steps')
	return errors
}

export async function generateRefinedFlow(options: GenerateFlowOptions): Promise<GenerateResult> {
	// 阶段标注：失败时错误对象带 detail（阶段+底层原因），AI 面板直接展示完整文本。
	let stage = '准备'
	try {
		if (!Array.isArray(options.flowFiles) || !options.flowFiles.length) {
			throw new Error('No source flows were selected for refinement.')
		}
		if (typeof options.runPrompt !== 'function') {
			throw new Error('A Pi prompt runner is required to generate a refined flow.')
		}
		stage = '加载源流程'
		const flows: Flow[] = []
		for (const file of options.flowFiles) flows.push(await loadFlow(file))
		const projection = projectFlows(flows)
		if (!options.templates?.autoSanitize || !options.templates?.refine) {
			throw new Error('Pi generation prompt templates are required (config/prompts.json).')
		}
		stage = '组装提示词'
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
		appLog('info', 'ai-refine', appLogFields({
			template: options.mode === 'auto' ? 'autoSanitize' : 'refine',
			sources: flows.length,
			sourceSteps: flows.reduce((total, flow) => total + flow.steps.length, 0),
			instructionChars: options.instruction?.length ?? 0,
			conversationTurns: options.conversation?.length ?? 0,
			promptChars: prompt.length,
		}))
		if (prompt.length > PROMPT_CAP) {
			throw new Error(
				`The refinement prompt is too large (${prompt.length} characters); split the flow or remove steps.`,
			)
		}
		stage = '调用模型'
		// 默认 300s：43k+ 字符提示 + 工具调用 + 代理链路下 180s 实测不够（2026-11-22 真机超时）。
		const timeoutMs = Math.max(5_000, Math.min(options.timeoutMs ?? 300_000, 600_000))
		const result = await options.runPrompt(prompt, timeoutMs)
		if (!result.ok) throw new Error(result.error || 'Pi agent request failed')

		stage = '解析模型输出'
		const parsed = extractJsonObject(result.text) as Record<string, unknown>
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Pi response is not a JSON object; the source was left unchanged.')
		}
		stage = '步骤再水化'
		const refIdsByStep = new Map<Record<string, unknown>, string[]>()
		let steps = rehydrateSteps(parsed.steps, projection.library, {
			onStepRefs: (step, refIds) => refIdsByStep.set(step, refIds),
		})
		// 容忍策略：模型输出的 assert/condition 缺断言定义 → 丢弃该步并记 risk，
		// 让细化可成功产出而非整次失败（否则 collectTemplateRefs 读 undefined.kind 崩溃）。
		const assertionDrop = dropStepsWithoutAssertion(steps)
		steps = assertionDrop.steps
		// 受控重锚定：修复证据命中库元素 → 前插 source:'ai' 候选（observed 不动）。
		if (options.reanchor?.length) steps = applyReanchor(steps, options.reanchor)
		const sources = options.sources?.length ? options.sources : undefined
		if (sources) annotateSourceFlowIds(steps, projection.library, refIdsByStep)
		// 执行方式归一在 id 落定（再水化/重锚定）之后执行，sidecar 才能对上最终步骤。
		stage = '执行方式归一'
		const executionModes = normalizeExecutionModes(steps, parsed.executionDecisions)
		const variables = mergeVariables(flows, parsed.variables, parsed.variableLabels, parsed.variableRules)
		// 参数保护守卫（不依赖模型自觉）：
		// 1) 引用了不存在的变量 → 整次生成失败（源流程不动，与现有错误路径一致）；
		// 2) 源 Flow 的变量定义属于流程契约，不能因模型改写步骤或引用扫描范围而被删除；
		// 3) 源流程有 secret 变量而输出步骤不再引用 → 追加一条 risk。
		stage = '参数守卫'
		const { used, defined } = collectTemplateRefs(steps)
		for (const name of used) {
			if (!defined.has(name) && !variables.some((v) => v.name === name)) {
				throw new Error(`生成的步骤引用了不存在的变量 {{${name}}}；源流程未改动`)
			}
		}
		const usedOrDefined = new Set([...used, ...defined])
		const sourceSecretNames = new Set(
			flows.flatMap((flow) => (flow.variables ?? []).filter((variable) => variable.secret).map((variable) => variable.name)),
		)
		const secretDroppedNames = [...sourceSecretNames].filter((name) => !usedOrDefined.has(name))
		stage = '契约校验与落盘前组装'
		// 嵌套多级输出契约：畸形即败（不产半成品），与 parseFlow strict 检查互补。
		const structureIssues = validateGenerationStructure(steps)
		if (structureIssues.length)
			throw new Error(`生成的分组结构不符合契约：\n  - ${structureIssues.join('\n  - ')}`)
		// 活动关联默认值（修订轮 D8）：清除源继承的悬空分组 id，使用证据推导优先，
		// 模型 variableActivities 建议仅补无证据变量（未知分组 id 剔除不拒）。
		stage = '活动关联'
		const suggestions = parseVariableActivities(
			parsed.variableActivities,
			new Set(variables.map((variable) => variable.name)),
		)
		const variablesWithActivities = applyActivityDefaults(variables, steps, suggestions)
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
				variables: variablesWithActivities,
				stats: undefined,
				selfHealed: [],
			},
			'<ai-refine>',
			{ strict: true },
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
				...assertionDrop.dropped,
				...(secretDroppedNames.length
					? [
							`源流程包含 secret 变量（${secretDroppedNames.map((name) => `{{${name}}}`).join(', ')}），但生成步骤不再引用：凭据步骤可能已被删除，请人工确认相关步骤`,
						]
					: []),
				...executionModes.risks,
			],
			executionDecisions: executionModes.decisions,
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			error: `Refine 失败（阶段：${stage}）：${reason}`,
			detail: { stage, reason },
		}
	}
}
