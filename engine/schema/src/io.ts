import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { FlowSchema, SCHEMA_VERSION, validateFlowContract, type Flow, type FlowContractOptions } from './schema.js'
import { assignLabels, mapLegacyType, type LabelEvidence, type LabelKindHint, type LabelSeed } from '../../reference/src/index.js'

/**
 * Flow 文件边界上的校验错误。`issues` 保留可逐项展示的诊断文本，
 * 而 source 标明这些问题来自哪一个文件或调用方提供的内存输入。
 */
export class FlowValidationError extends Error {
	readonly issues: string[]
	constructor(source: string, issues: string[]) {
		super(`flow 校验失败（${source}）:\n  - ${issues.join('\n  - ')}`)
		this.name = 'FlowValidationError'
		this.issues = issues
	}
}

/**
 * 把不可信输入迁移、解析并执行跨字段契约检查，产出当前版本的 Flow。
 * 结构错误或契约错误均以 FlowValidationError 报告；迁移遇到不支持的版本则明确失败。
 */
export function parseFlow(input: unknown, source = '<memory>', opts: FlowContractOptions = {}): Flow {
	// 先迁移旧结构，再做 Zod 结构解析与跨字段契约检查；任何一步失败都不返回部分结果。
	const migrated = migrateFlow(input)
	const parsed = FlowSchema.safeParse(migrated)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
		throw new FlowValidationError(source, issues)
	}
	const contractIssues = validateFlowContract(parsed.data, opts)
	if (contractIssues.length) throw new FlowValidationError(source, contractIssues)
	return parsed.data
}

/**
 * 版本迁移。v0（无 schemaVersion）→ v1：补默认字段；v1 → v2：保留原有顺序 flow，
 * 新的条件分支字段仅由新建/编辑的 flow 使用。
 */
export function migrateFlow(raw: unknown): unknown {
	if (typeof raw !== 'object' || raw === null) return raw
	// 复制顶层对象，迁移只补充新版本所需字段，不改调用方持有的原对象。
	const doc = { ...(raw as Record<string, unknown>) }
	let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0
	// 只做明确支持的逐级升级；未知或未来版本不得静默降级。
	if (version > SCHEMA_VERSION) {
		throw new Error(`flow 版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}，请升级 rr`)
	}
	if (version === 0) {
		Object.assign(doc, {
			schemaVersion: 1,
			version: typeof doc.version === 'number' ? doc.version : 1,
			selfHealed: Array.isArray(doc.selfHealed) ? doc.selfHealed : [],
		})
		version = 1
	}
	if (version === 1) {
		doc.schemaVersion = 2
		version = 2
	}
	if (version === 2) {
		doc.schemaVersion = 3
		version = 3
		migrateVariablesV2ToV3(doc)
	}
	if (version === SCHEMA_VERSION) return doc
	throw new Error(`未知的 flow 版本 ${version}`)
}

/* ------------------------------------------------------------------ */
/* v2 → v3：Reference 元数据升级（只动 variables，不改写步骤/模板）       */
/* ------------------------------------------------------------------ */

/** 从步骤侧提取单个变量的命名证据（结构化平面，避开对 ElementRef 类型的依赖） */
function evidenceFromTarget(target: unknown, pageIndex: number): LabelEvidence {
	const ref = (target ?? {}) as {
		observed?: { attributes?: Record<string, string> }
		candidates?: Array<{ kind?: string; value?: unknown }>
		fingerprint?: { accessibleName?: string }
	}
	const attrs = ref.observed?.attributes ?? {}
	const labelCandidate = ref.candidates?.find(
		(candidate) => candidate.kind === 'label' && typeof candidate.value === 'string',
	)
	return {
		labelText: (labelCandidate?.value as string | undefined) ?? ref.fingerprint?.accessibleName,
		placeholder: attrs['placeholder'],
		ariaLabel: attrs['aria-label'],
		nameAttr: attrs['name'],
		inputType: attrs['type'],
		pageIndex,
	}
}

/** 机器键 → 种类提示（无元素证据时的兜底语义） */
function kindHintForName(name: string): LabelKindHint | undefined {
	if (/^url_\d+$/.test(name)) return 'url'
	if (name === 'password') return 'password'
	if (/^file_\d+$/.test(name)) return 'upload'
	if (/^select_\d+$/.test(name)) return 'select'
	if (/^input_\d+$/.test(name)) return 'input'
	return undefined
}

/** 收集一条字符串值里全部 {{name}} 引用（非法模板直接跳过：迁移不因模板语法改判） */
function templateNamesOf(value: unknown): string[] {
	if (typeof value !== 'string') return []
	const out: string[] = []
	const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
	for (const match of value.matchAll(re)) out.push(match[1]!)
	return out
}

/**
 * 遍历原始步骤，为每个被 {{name}} 引用的变量收集首个出现位置的命名证据。
 * 递归进入 group；不修改任何步骤数据。
 */
function collectVariableSeeds(steps: unknown): Map<string, LabelSeed> {
	const seeds = new Map<string, LabelSeed>()
	const note = (name: string, target: unknown, pageIndex: number): void => {
		if (seeds.has(name)) return
		seeds.set(name, {
			key: name,
			evidence: evidenceFromTarget(target, pageIndex),
			...(kindHintForName(name) ? { kindHint: kindHintForName(name)! } : {}),
		})
	}
	const visitStep = (raw: unknown, pageIndex: number): void => {
		const step = (raw ?? {}) as Record<string, unknown>
		const pageIndexOfStep = typeof step['page'] === 'object' && step['page'] !== null
			? ((step['page'] as { index?: unknown }).index as number | undefined)
			: undefined
		const effectivePage = typeof pageIndexOfStep === 'number' ? pageIndexOfStep : pageIndex
		const target = step['target']
		const noteAll = (value: unknown): void => {
			for (const name of templateNamesOf(value)) note(name, target, effectivePage)
		}
		noteAll(step['url'])
		noteAll(step['value'])
		noteAll(step['promptText'])
		noteAll(step['prompt'])
		noteAll(step['key'])
		if (Array.isArray(step['files'])) for (const file of step['files']) noteAll(file)
		const expect = step['expect'] as Record<string, unknown> | undefined
		if (expect) {
			noteAll(expect['pattern'])
			noteAll(expect['to'])
		}
		const assertion = step['assertion'] as Record<string, unknown> | undefined
		if (assertion) {
			noteAll(assertion['equals'])
			noteAll(assertion['contains'])
		}
		if (Array.isArray(step['steps'])) for (const child of step['steps']) visitStep(child, effectivePage)
	}
	if (Array.isArray(steps)) for (const step of steps) visitStep(step, 0)
	return seeds
}

/**
 * v2 → v3 变量升级（就地改写 doc.variables）：
 * - 类型映射：text→string、email→string+email 格式预设、number→按默认值判 integer/decimal；
 * - secret 与 type 互为一致（type=secret ⇒ secret=true，secret=true ⇒ type=secret）；
 * - label 由共享启发式按步骤证据回填（成对日期/去重/业务化兜底）；
 * - required/validation（除 email 预设外）/activities 缺省为空。
 * 不改写步骤与模板键。
 */
function migrateVariablesV2ToV3(doc: Record<string, unknown>): void {
	const rawVariables = Array.isArray(doc['variables']) ? doc['variables'] : []
	if (!rawVariables.length) return
	const seeds = collectVariableSeeds(doc['steps'])
	// 生成 label：按变量数组序组织 seeds（成对日期与去重依赖全量上下文）。
	const orderedSeeds: LabelSeed[] = []
	for (const raw of rawVariables) {
		const name = (raw as { name?: unknown })['name']
		if (typeof name !== 'string') continue
		const seed = seeds.get(name)
		if (seed) {
			orderedSeeds.push(seed)
			continue
		}
		// 步骤里找不到引用的变量（extract 产物等）：按种类提示走类型语义兜底
		const kindHint = kindHintForName(name)
		orderedSeeds.push({ key: name, evidence: {}, ...(kindHint ? { kindHint } : {}) })
	}
	const labels = assignLabels(orderedSeeds)
	let labelIndex = 0
	const migrated = rawVariables.map((raw) => {
		const variable = { ...(raw as Record<string, unknown>) }
		const name = variable['name']
		if (typeof name !== 'string') return variable
		const defaultValue = typeof variable['defaultValue'] === 'string' ? (variable['defaultValue'] as string) : undefined
		const legacyType = typeof variable['type'] === 'string' ? (variable['type'] as string) : 'string'
		const mapping = mapLegacyType(legacyType, defaultValue)
		variable['type'] = mapping.type
		const label = labels[labelIndex++]
		if (label) variable['label'] = label
		if (mapping.formatPreset) {
			const validation = { ...(variable['validation'] as Record<string, unknown> | undefined) }
			const format = { ...(validation['format'] as Record<string, unknown> | undefined) }
			format['preset'] = mapping.formatPreset
			validation['format'] = format
			variable['validation'] = validation
		}
		// secret 与 type 保持一致（两字段历史上并存，v3 起互为镜像）
		if (variable['type'] === 'secret') variable['secret'] = true
		else if (variable['secret'] === true) variable['type'] = 'secret'
		return variable
	})
	doc['variables'] = migrated
}

/** 读取 JSON 文本并走与内存输入相同的迁移和完整校验路径。 */
export async function loadFlow(file: string): Promise<Flow> {
	const text = await readFile(file, 'utf8')
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (err) {
		throw new Error(`无法解析 flow（${file}）：${(err as Error).message}`)
	}
	return parseFlow(raw, file)
}

/** 仅负责稳定、可读的 JSON 编码；写入前的完整性保证由 saveFlow 提供。 */
export function serializeFlow(flow: Flow): string {
	return `${JSON.stringify(flow, null, 2)}\n`
}

export interface SaveOptions {
		/** 覆盖前把旧文件复制为 .bak（用于自愈写回）。 */
	backup?: boolean
}

/**
 * 校验后写入 flow：先写同目录临时文件，再 rename 替换目标，降低中断时的半写风险。
 * backup=true 时先尝试保留旧内容为 `.bak`；首次写入没有旧文件属于正常情况。
 */
export async function saveFlow(flow: Flow, file: string, opts: SaveOptions = {}): Promise<void> {
	// 写入前完整校验（strict：id 全命名空间唯一、空组拒绝）；非法 IR 不得落盘。
	const validated = parseFlow(flow, file, { strict: true })
	await mkdir(dirname(file), { recursive: true })
	if (opts.backup) {
		try {
			await copyFile(file, `${file}.bak`)
		} catch {
			/* 首次写入没有旧文件，忽略 */
		}
	}
	const tmp = `${file}.tmp`
	await writeFile(tmp, serializeFlow(validated), 'utf8')
	await rename(tmp, file)
}

/** 为新建 flow/步骤生成易读且低碰撞概率的 ID；不作为密码学随机标识使用。 */
export function makeId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
