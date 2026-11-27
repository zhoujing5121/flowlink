/**
 * Reference 原始类型目录：封闭枚举 + 终端显示映射的唯一来源。
 *
 * 设计约定（openspec change: formalize-reference）：
 * - Reference 对象直接持有原始类型，不再经过 "Variable" 中间层包装；
 * - 「正数」等约束是校验规则（validate.ts），不设独立类型；
 * - 本包是纯函数与常量，不依赖其他 engine 包；schema 的 Zod 枚举、
 *   迁移的类型映射、渲染层的显示映射都从这里取同一份目录。
 */

/** 封闭类型目录：机器值（持久化/模板语义） */
export const REFERENCE_TYPES = [
	'url',
	'string',
	'integer',
	'decimal',
	'date',
	'secret',
	'excel',
	'word',
	'csv',
	'md',
	'file',
] as const

export type ReferenceType = (typeof REFERENCE_TYPES)[number]

/** 终端用户显示名（唯一，面向 UI/导出；机器值不出现在用户视野） */
export const TYPE_DISPLAY: Readonly<Record<ReferenceType, string>> = {
	url: '网址',
	string: '文本',
	integer: '整数',
	decimal: '小数',
	date: '日期',
	secret: '密钥',
	excel: 'Excel',
	word: 'Word',
	csv: 'CSV',
	md: 'Markdown',
	file: '文件',
}

/** 运行时类型守卫：判断任意值是否为目录内的合法 Reference 类型（迁移与输入校验共用）。 */
export function isReferenceType(value: unknown): value is ReferenceType {
	return typeof value === 'string' && (REFERENCE_TYPES as readonly string[]).includes(value)
}

/** 文件类类型（值 = 持久化附件；编辑对话框值栏为上传控件，回放注入工件内绝对路径） */
export const FILE_REFERENCE_TYPES = ['excel', 'word', 'csv', 'md', 'file'] as const

/** 运行时守卫：该类型是否允许携带持久化附件（附件路径契约见 schema 的 isSafeReferenceFilePath）。 */
export function isFileReferenceType(value: unknown): boolean {
	return typeof value === 'string' && (FILE_REFERENCE_TYPES as readonly string[]).includes(value)
}

/** 面向用户的类型显示名；未知值原样返回（防御旧数据，不静默改写）。 */
export function displayType(type: string): string {
	return isReferenceType(type) ? TYPE_DISPLAY[type] : type
}

/* ------------------------------------------------------------------ */
/* 旧类型映射（schema v2 → v3 迁移与 AI 输出归一共用）                  */
/* ------------------------------------------------------------------ */

export interface LegacyTypeMapping {
	type: ReferenceType
	/** email 旧类型迁移为 string 时附带 email 格式预设校验 */
	formatPreset?: 'email'
}

/**
 * 旧枚举（string/text/email/date/number/secret/file）→ 新目录。
 * number 按默认值是否含小数点判 integer/decimal（defaultValue 传入）。
 */
export function mapLegacyType(legacyType: string, defaultValue?: string): LegacyTypeMapping {
	// 新目录内的类型直通（v3 数据与 AI 输出可能携带新枚举）
	if (isReferenceType(legacyType)) return { type: legacyType }
	switch (legacyType) {
		case 'text':
			return { type: 'string' }
		case 'email':
			return { type: 'string', formatPreset: 'email' }
		case 'number':
			return { type: defaultValue !== undefined && defaultValue.includes('.') ? 'decimal' : 'integer' }
		case 'date':
			return { type: 'date' }
		case 'secret':
			return { type: 'secret' }
		case 'file':
			return { type: 'file' }
		default:
			return { type: 'string' }
	}
}

/* ------------------------------------------------------------------ */
/* 上传文件扩展名 → 类型目录                                            */
/* ------------------------------------------------------------------ */

/** Reference 上传允许的扩展名（accept 列表的唯一来源；含 .docx） */
export const REFERENCE_FILE_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.md', '.markdown', '.docx'] as const

/** 按扩展名把上传文件映射进类型目录；不支持的扩展名返回 undefined。 */
export function referenceTypeFromFileName(fileName: string): ReferenceType | undefined {
	const dot = fileName.lastIndexOf('.')
	if (dot < 0) return undefined
	const ext = fileName.slice(dot).toLowerCase()
	switch (ext) {
		case '.xlsx':
		case '.xls':
			return 'excel'
		case '.csv':
			return 'csv'
		case '.md':
		case '.markdown':
			return 'md'
		case '.docx':
			return 'word'
		default:
			return undefined
	}
}
