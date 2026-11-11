import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { FlowSchema, SCHEMA_VERSION, validateFlowContract, type Flow } from './schema.js'

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
export function parseFlow(input: unknown, source = '<memory>'): Flow {
	// 先迁移旧结构，再做 Zod 结构解析与跨字段契约检查；任何一步失败都不返回部分结果。
	const migrated = migrateFlow(input)
	const parsed = FlowSchema.safeParse(migrated)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
		throw new FlowValidationError(source, issues)
	}
	const contractIssues = validateFlowContract(parsed.data)
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
	if (version === SCHEMA_VERSION) return doc
	throw new Error(`未知的 flow 版本 ${version}`)
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
	// 写入前完整校验；非法 IR 不得落盘。
	const validated = parseFlow(flow, file)
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
