/**
 * 变量（Reference 对象）的 schema：上传文件元数据、附件与变量定义。
 * 敏感值永远不落明文：password 这类字段必须是 {{var}} 模板（契约校验在 contract.ts）。
 */
import { z } from 'zod'

import { REFERENCE_TYPES } from '../../reference/src/type-catalog.js'

/** 上传 Reference 文件的持久化元数据：path 相对录制工件根，必须落在 references/ 内 */
export const ReferenceFileSchema = z.object({
	id: z.string().min(1),
	/** 原始显示文件名（用户可见） */
	name: z.string().min(1),
	type: z.enum(['excel', 'word', 'csv', 'md', 'file']),
	/** 相对工件根的落盘路径，形如 references/<文件名>；契约校验禁止逃逸 */
	path: z.string().min(1),
})
export type ReferenceFile = z.infer<typeof ReferenceFileSchema>

/**
 * Reference 文件路径契约：必须是 `references/` 下不含子目录、不含 `..`、
 * 不含分隔符的单段文件名（相对录制工件根）。
 */
export function isSafeReferenceFilePath(path: string): boolean {
	if (!path.startsWith('references/')) return false
	const fileName = path.slice('references/'.length)
	if (!fileName || fileName.includes('/') || fileName.includes('\\')) return false
	if (fileName.includes('..') || fileName.trim() !== fileName) return false
	return !/[\u0000-\u001f\u007f]/.test(fileName)
}

/** 文件类对象（excel/word/csv/md/file）的可选附件元数据：path 相对工件根，复用 references/ 单段防逃逸契约 */
export const VariableAttachmentSchema = z.object({
	/** 附件显示文件名 */
	name: z.string().min(1),
	/** 相对录制工件根的落盘路径，形如 references/<文件名> */
	path: z.string().min(1),
})
export type VariableAttachment = z.infer<typeof VariableAttachmentSchema>

export const VariableSchema = z.object({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '变量名必须是合法标识符'),
	/** 业务显示名（唯一面向用户的名称）；机器键不出现在用户视野 */
	label: z.string().min(1).max(200).optional(),
	/** 封闭类型目录（engine/reference type-catalog）：url/string/integer/decimal/date/secret/excel/word/csv/md/file */
	type: z.enum(REFERENCE_TYPES).default('string'),
	defaultValue: z.string().optional(),
	/** secret 变量不会以明文出现在动作轨迹中；界面只显示 ****** */
	secret: z.boolean().default(false),
	/** 必填（显示名 Mandatory）：回放启动前缺失则拒绝启动 */
	required: z.boolean().optional(),
	/** 自由文本规则（自然语言填写/校验要求）：程序只存储与展示，不解析、不执行 */
	rules: z.string().max(4_000).optional(),
	/** 来源定位描述（「页面 · 控件」）：对象从哪个页面的哪个控件拍取；录制端与迁移自动产出，可编辑 */
	locator: z.string().max(500).optional(),
	/** 关联的 L1 活动分组 id（Refine 后顶层分组）；未 Refine 录制的隐含整段活动不入此数组 */
	activities: z.array(z.string().min(1)).optional(),
	/** 文件类对象的可选附件（值即文件）；回放时解析为工件内绝对路径注入 */
	file: VariableAttachmentSchema.optional(),
	source: z.enum(['input', 'csv']).default('input'),
})
export type Variable = z.infer<typeof VariableSchema>
