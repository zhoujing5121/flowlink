/**
 * Reference 变量与附件的原子保存（修订轮 3，D10）。
 *
 * 主进程 flow:updateVariables 使用；保持无 Electron 依赖以便 node:test 直测。
 * 原子性策略：附件字节先写入 references/，随后变量元数据经 parseFlow strict 校验并
 * 同一次版本递增落盘；落盘失败回滚本次新写的文件，避免文件与元数据脱节。
 * 落盘成功后清理不再被引用的旧附件文件（替换上传 / 删除附件 / 删除对象行）。
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loadFlow, parseFlow, saveFlow, VariableSchema, type Variable } from '../../engine/schema/src/index.js'
import {
	isFileReferenceType,
	isInsideDirectory,
	planReferenceFileTarget,
	resolveAttachmentPath,
	validateReferences,
	type ValidationIssue,
} from '../../engine/reference/src/index.js'

export interface AttachmentUpload {
	/** 目标变量机器键 */
	name: string
	/** 原始文件名（用户可见名） */
	fileName: string
	/** 文件字节（渲染层读入后经 IPC 结构化克隆传入） */
	data: Uint8Array
}

export interface SaveVariablesResult {
	variables: Variable[]
	/** 本次写入的附件（机器键 → 相对路径 + 绝对路径） */
	stored: Array<{ name: string; path: string; absolutePath: string }>
}

/**
 * 变量元数据 + 附件原子保存：
 * 1) 校验附件（目标存在、为文件类对象、字节非空、无重复目标）；
 * 2) 清洗命名 + 碰撞去重规划 references/ 落盘路径，先写文件；
 * 3) parseFlow strict（含附件契约）→ saveFlow（version+1，.bak）；失败回滚新写文件；
 * 4) 清理旧 flow 中不再被引用的附件文件。
 */
export async function saveVariablesWithAttachments(opts: {
	flowFile: string
	artifactsDir: string
	variables: unknown[]
	attachments?: AttachmentUpload[]
}): Promise<SaveVariablesResult> {
	const { flowFile, artifactsDir } = opts
	const attachments = opts.attachments ?? []
	const flow = await loadFlow(flowFile)
	const parsedVariables = VariableSchema.array().parse(opts.variables)
	const byName = new Map(parsedVariables.map((variable) => [variable.name, variable]))

	const seenTargets = new Set<string>()
	const referencesDir = join(artifactsDir, 'references')
	const existing = await readdir(referencesDir).catch(() => [] as string[])
	const assigned = new Map<string, { name: string; path: string }>()
	const written: Array<{ name: string; path: string; absolutePath: string }> = []

	for (const attachment of attachments) {
		if (
			!attachment ||
			typeof attachment.name !== 'string' ||
			typeof attachment.fileName !== 'string' ||
			!(attachment.data instanceof Uint8Array) ||
			!attachment.data.byteLength
		) {
			throw new Error('附件上传请求无效（需 name/fileName/非空字节）')
		}
		if (seenTargets.has(attachment.name)) {
			throw new Error(`同一对象的重复附件上传：${attachment.name}`)
		}
		seenTargets.add(attachment.name)
		const target = byName.get(attachment.name)
		if (!target) throw new Error(`附件目标变量不存在：${attachment.name}`)
		if (!isFileReferenceType(target.type)) {
			throw new Error(`只有文件类对象（excel/word/csv/md/file）可携带附件：${target.name} 当前类型 ${target.type}`)
		}
		const plan = planReferenceFileTarget(referencesDir, attachment.fileName, [
			...existing,
			...written.map((item) => item.path.slice('references/'.length)),
		])
		assigned.set(attachment.name, { name: plan.displayName, path: plan.relativePath })
		written.push({ name: attachment.name, path: plan.relativePath, absolutePath: plan.absolutePath })
	}

	// 新附件覆盖 file 元数据；渲染层对取消/无附件的对象省略 file 字段
	const nextVariables = parsedVariables.map((variable) =>
		assigned.has(variable.name) ? { ...variable, file: assigned.get(variable.name) } : { ...variable },
	)

	await mkdir(referencesDir, { recursive: true })
	const bytesByTarget = new Map(attachments.map((attachment) => [attachment.name, attachment.data]))
	await Promise.all(
		written.map((item) => writeFile(item.absolutePath, bytesByTarget.get(item.name)!)),
	)

	try {
		const updated = parseFlow(
			{ ...flow, version: flow.version + 1, variables: nextVariables },
			flowFile,
			{ strict: true },
		)
		await saveFlow(updated, flowFile, { backup: true })
	} catch (error) {
		// 元数据落盘失败：回滚本次新写的文件，保持文件与元数据一致
		await Promise.allSettled(written.map((item) => rm(item.absolutePath, { force: true })))
		throw error
	}

	// 孤儿清理：旧附件路径不再被任何新变量引用 → 删除（防逃逸后再删）
	const referencedPaths = new Set(
		nextVariables.filter((variable) => variable.file).map((variable) => variable.file!.path),
	)
	for (const oldVariable of flow.variables) {
		const oldPath = oldVariable.file?.path
		if (!oldPath || referencedPaths.has(oldPath)) continue
		const absolutePath = resolve(artifactsDir, oldPath)
		if (!isInsideDirectory(referencesDir, absolutePath)) continue
		await rm(absolutePath, { force: true })
	}

	return { variables: nextVariables, stored: written }
}

export interface GateOutcome {
	ok: boolean
	issues: ValidationIssue[]
	values: Record<string, string>
	injectedEmpty: string[]
}

/**
 * 回放启动闸门（主进程单一入口）：validateReferences（附件解析为工件内绝对路径）
 * + 附件文件在磁盘上的存在性检查（fs 检查留在主进程侧，validate.ts 保持纯函数）。
 */
export async function gateReferenceVariables(
	variables: ReadonlyArray<Variable>,
	userValues: Record<string, string>,
	artifactsDir: string,
): Promise<GateOutcome> {
	const gate = validateReferences(variables, userValues, { artifactsDir })
	const issues = [...gate.issues]
	for (const variable of variables) {
		if (!variable.file) continue
		try {
			const absolutePath = resolveAttachmentPath(artifactsDir, variable.file.path)
			await readFile(absolutePath)
		} catch (error) {
			issues.push({
				name: variable.name,
				label: variable.label || variable.name,
				reason:
					error instanceof Error && /越界/.test(error.message)
						? error.message
						: `附件文件不存在：${variable.file.name}`,
			})
		}
	}
	return { ok: issues.length === 0, issues, values: gate.values, injectedEmpty: gate.injectedEmpty }
}
