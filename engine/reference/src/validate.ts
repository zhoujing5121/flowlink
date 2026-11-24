/**
 * Reference 闸门求值器（收缩版，openspec change: simplify-reference-rules D2）。
 *
 * 语义（spec: replay-execution / Replay SHALL gate on Reference mandatory values）：
 * - 程序侧唯一保留的强制行为是 Mandatory：必填对象缺失 → 具名违规（一次性收集全部）；
 * - 规则文本（rules）不参与程序侧校验——不解析、不执行（格式/大小写/公式/条件随
 *   结构化校验一并移除，AI 理解与执行属后续能力）；
 * - 注入语义：非必填且无值、无默认的对象以空串注入；文件类对象携带附件时注入
 *   工件内绝对路径（upload 步骤直接可用），越界即具名违规；
 * - 密钥对象沿用只进当次回放、不落盘的既有行为。
 */
import { isFileReferenceType } from './type-catalog.js'
import { resolveAttachmentPath } from './files.js'

/** 参与闸门检查的对象（Variable 的运行时平面形态；label 缺省回退机器名） */
export interface ReferenceObjectInput {
	name: string
	label?: string
	type?: string
	defaultValue?: string
	secret?: boolean
	required?: boolean
	/** 文件类对象（excel/word/csv/md/file）的持久化附件；回放时解析为工件内绝对路径注入 */
	file?: { name: string; path: string }
}

/** 一条具名违规：可定位到对象 */
export interface ValidationIssue {
	/** 机器键 */
	name: string
	/** 面向用户的对象名（label） */
	label: string
	/** 原因（中文） */
	reason: string
}

export interface ValidateOptions {
	/** 录制工件根目录：提供时把文件类对象的附件解析为工件内绝对路径注入 */
	artifactsDir?: string
}

export interface ValidateResult {
	/** 无违规时为 true */
	ok: boolean
	/** 全部违规（一次性收集） */
	issues: ValidationIssue[]
	/** 解析后值表（机器键 → 注入值；附件绝对路径 / 空串填充完成） */
	values: Record<string, string>
	/** 空串注入的对象机器键清单（供回放报告/事后排查） */
	injectedEmpty: string[]
}

function objectLabel(obj: ReferenceObjectInput): string {
	const label = typeof obj.label === 'string' ? obj.label.trim() : ''
	return label || obj.name
}

/**
 * 统一闸门求值：必填缺失收集 + 附件绝对路径解析 + 非必填空串填充。
 * 一次性收集全部违规，不首错即停；纯函数，无 IO。
 */
export function validateReferences(
	objects: readonly ReferenceObjectInput[],
	userValues: Readonly<Record<string, string>> = {},
	options: ValidateOptions = {},
): ValidateResult {
	const issues: ValidationIssue[] = []
	const values: Record<string, string> = {}
	const injectedEmpty: string[] = []

	for (const obj of objects) {
		// 文件类附件：值 = 工件内绝对路径（upload 步骤直接可用）；路径必须留在 references/ 内。
		if (obj.file && isFileReferenceType(obj.type)) {
			if (options.artifactsDir) {
				try {
					values[obj.name] = resolveAttachmentPath(options.artifactsDir, obj.file.path)
				} catch (error) {
					values[obj.name] = ''
					issues.push({
						name: obj.name,
						label: objectLabel(obj),
						reason: error instanceof Error ? error.message : String(error),
					})
				}
			} else {
				values[obj.name] = ''
			}
			continue
		}
		// 普通对象：用户值 > 默认值 > 空串（非必填缺失以空串注入，不再硬失败）
		const user = userValues[obj.name]
		const value = typeof user === 'string' ? user : (typeof obj.defaultValue === 'string' ? obj.defaultValue : '')
		values[obj.name] = value
		if (value === '' && obj.required) {
			issues.push({ name: obj.name, label: objectLabel(obj), reason: '必填对象没有值' })
		} else if (
			value === '' &&
			typeof user !== 'string' &&
			typeof obj.defaultValue !== 'string'
		) {
			injectedEmpty.push(obj.name)
		}
	}

	return { ok: issues.length === 0, issues, values, injectedEmpty }
}
