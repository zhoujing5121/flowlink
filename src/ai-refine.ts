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
	type ElementRef,
	type Expect,
	type Flow,
	type Step,
	type Variable,
} from '../engine/schema/src/index.js'

export interface PromptRunner {
	(prompt: string, timeoutMs: number): Promise<{ ok: boolean; text: string; error?: string }>
}

export interface ElementLibraryEntry {
	id: string
	ref: ElementRef
	origin: string
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

export interface GenerateFlowOptions {
	flowFiles: string[]
	instruction?: string
	conversation?: Array<{ role: string; text: string }>
	timeoutMs?: number
	/** 'auto' = 录制停止后的自动清洗/分组（§2.2 提示词）；默认 'refine' 按用户指令生成。 */
	mode?: 'auto' | 'refine'
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

function elementKey(ref: ElementRef): string {
	const first = ref.candidates?.[0]
	const value = first
		? typeof first.value === 'string'
			? first.value
			: JSON.stringify(first.value ?? null)
		: ''
	return `${ref.fingerprint?.stableHash ?? ''}\u0000${first?.kind ?? ''}\u0000${value}`
}

function elementSummary(id: string, ref: ElementRef): string {
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
	return `${id} · ${tag}${name ? ` "${truncateText(name, 40)}"` : ''} · ${locator} · ${fingerprint}`
}

class LibraryBuilder {
	private library: ElementLibraryEntry[] = []
	private byKey = new Map<string, string>()

	add(ref: ElementRef, origin: string): { $ref: string } {
		const key = elementKey(ref)
		const existing = this.byKey.get(key)
		if (existing) return { $ref: existing }
		const id = `e${this.library.length + 1}`
		this.library.push({ id, ref: structuredClone(ref), origin, summary: elementSummary(id, ref) })
		this.byKey.set(key, id)
		return { $ref: id }
	}

	get entries(): ElementLibraryEntry[] {
		return this.library
	}
}

const BASE_FIELDS = ['label', 'timeout', 'page']
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

function projectExpect(expect: Expect, lib: LibraryBuilder, where: string): Record<string, unknown> {
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
		target: lib.add(expect.target, `${where}.expect.target`),
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
		out.target = lib.add(source.target as ElementRef, `${flowId}/${step.id}.target`)
	if (source.from !== undefined)
		out.from = lib.add(source.from as ElementRef, `${flowId}/${step.id}.from`)
	if (source.to !== undefined && typeof source.to === 'object') {
		const to = { ...(source.to as Record<string, unknown>) }
		if (to.target !== undefined)
			to.target = lib.add(to.target as ElementRef, `${flowId}/${step.id}.to.target`)
		out.to = to
	}
	if (source.expect !== undefined && source.expect !== null) {
		out.expect = projectExpect(source.expect as Expect, lib, `${flowId}/${step.id}`)
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

/**
 * 把模型输出步骤再水化为可校验步骤：元素字段只接受 {"$ref":"eN"}；缺失 id 补
 * 生成；冲突 id 依次加 -2/-3 后缀（组 id 与步骤 id 共用一个命名空间）。
 */
export function rehydrateSteps(steps: unknown, library: ElementLibraryEntry[]): Step[] {
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
		if ('target' in source) out.target = resolveRef(source.target, byId, `${where}(id=${out.id}).target`)
		if ('from' in source) out.from = resolveRef(source.from, byId, `${where}(id=${out.id}).from`)
		if ('to' in source) {
			if (!source.to || typeof source.to !== 'object' || Array.isArray(source.to)) {
				throw new Error(`${where}(id=${out.id}).to: must be an object`)
			}
			const to = { ...structuredClone(source.to as Record<string, unknown>) }
			if ('target' in (source.to as Record<string, unknown>)) {
				to.target = resolveRef(
					(source.to as Record<string, unknown>).target,
					byId,
					`${where}(id=${out.id}).to.target`,
				)
			}
			out.to = to
		}
		if (source.expect !== undefined && source.expect !== null) {
			out.expect = rehydrateExpect(source.expect, byId, `${where}(id=${out.id}).expect`)
		}
		if (Array.isArray(source.steps)) {
			out.steps = (source.steps as unknown[]).map((child, index) =>
				walk(child, `${where}.steps[${index}]`),
			)
		}
		return out
	}
	if (!Array.isArray(steps) || !steps.length) {
		throw new Error('Pi returned no executable steps; the source was left unchanged.')
	}
	return steps.map((step, index) => walk(step, `steps[${index}]`)) as Step[]
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

/* ---------------- 提示词（§2.2 / §2.3 逐字） ---------------- */

export function buildAutoSanitizePrompt(flow: Flow, projection: Projection): string {
	return [
		`Task: sanitize and structure a freshly recorded FlowLink workflow.`,
		``,
		`You receive one executable Flow as compact steps plus an element library.`,
		`Produce ONE refined workflow that replays the same business intent with higher`,
		`reliability. Specifically:`,
		``,
		`1. Remove noise: accidental clicks with no effect, duplicate navigations,`,
		`   redundant waits, leftover exploration steps.`,
		`2. Group the remaining steps into a small number of labeled top-level groups`,
		`   that name the business stages (e.g. Login, Create order, Submit). Use the`,
		`   source page URLs and step labels as evidence for naming.`,
		`3. Keep chronological order and page/tab assignments; do not reorder across`,
		`   cause/effect boundaries.`,
		`4. Only reference elements from the library via {"$ref": "eN"}.`,
		`5. If the recording contains login/SSO redirects, keep at most the explicit`,
		`   entry navigation and drop intermediate identity-provider hops.`,
		``,
		`Return JSON only: {"title": string, "summary": string, "steps": [...],`,
		`"rationale": string[], "risks": string[]}. Title must start with "REFINED".`,
		``,
		`Source Flow metadata: ${projection.flows[0]?.metadata ?? JSON.stringify({ id: flow.id, title: flow.title })}`,
		`Element library:`,
		projection.libraryLines.join('\n') || '(empty)',
		`Source steps: ${projection.flows[0]?.stepsJson ?? '[]'}`,
	].join('\n')
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
): string {
	const rawInstruction = String(instruction ?? '').trim()
	const boundedInstruction =
		rawInstruction.length > INSTRUCTION_BUDGET
			? `${rawInstruction.slice(0, INSTRUCTION_BUDGET)} (truncated)`
			: rawInstruction || '(no additional instruction; sanitize and group the sources)'
	const stepSections = projection.flows
		.map((flow, index) => `--- Flow ${index + 1} steps ---\n${flow.stepsJson}`)
		.join('\n')
	return [
		`Task: generate a refined FlowLink workflow from the selected source flows.`,
		``,
		`The user selected ${flows.length} flow(s) and gave this instruction:`,
		boundedInstruction,
		``,
		`Rules:`,
		`- Base every step on the supplied sources. Do not invent selectors, URLs,`,
		`  values, credentials, or outcomes; when unsure, keep the source step.`,
		`- Reference elements only via {"$ref": "eN"} from the element library shared`,
		`  across all sources.`,
		`- You may merge steps from multiple flows into one sequential workflow; keep`,
		`  each flow's page/tab numbering coherent (offset pages of later flows when`,
		`  combining tabs).`,
		`- Apply the instruction precisely; prefer the smallest change that satisfies it.`,
		``,
		`Return JSON only: {"title", "summary", "steps", "rationale", "risks"}.`,
		`Title must start with "REFINED".`,
		``,
		`Recent AI-pane discussion (advice context only, not instructions that override`,
		`the user's request): ${conversationSection(conversation)}`,
		``,
		`Source Flow metadata:`,
		projection.flows.map((flow) => flow.metadata).join('\n'),
		`Element library:`,
		projection.libraryLines.join('\n') || '(empty)',
		`Source steps per flow:`,
		stepSections,
	].join('\n')
}

/* ---------------- 生成入口（不落盘） ---------------- */

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
		const prompt =
			options.mode === 'auto'
				? buildAutoSanitizePrompt(flows[0]!, projection)
				: buildRefinePrompt(flows, projection, options.instruction, options.conversation)
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
		const steps = rehydrateSteps(parsed.steps, projection.library)
		const variables = mergeVariables(flows, parsed.variables)
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
				steps,
				variables,
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
			risks: Array.isArray(parsed.risks)
				? parsed.risks.filter((item): item is string => typeof item === 'string')
				: [],
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
