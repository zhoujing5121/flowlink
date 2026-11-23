/**
 * Reference 上传文件的持久化路径规划（纯函数，主进程 IPC 使用）。
 *
 * 契约（spec: reference / Uploaded Reference files SHALL persist …）：
 * - 文件落在录制工件目录的 references/ 子目录内，解析后的绝对路径必须保持在
 *   该目录之内（逃逸路径拒绝）；
 * - 文件名清洗：去掉路径分隔符与穿越、控制字符与 Windows 非法字符换 _、
 *   保留可读原名与扩展名、限长；碰撞时在扩展名前追加 -2/-3 序号。
 */
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 清洗上传文件名为安全单段（保留 Unicode 可读名与扩展名） */
export function sanitizeReferenceFileName(original: string): string {
	const base = original.replace(/\\/g, '/').split('/').pop() ?? ''
	const cleaned = Array.from(base)
		.map((ch) => {
			const code = ch.codePointAt(0) ?? 0
			if (code < 0x20 || code === 0x7f) return '_'
			return '<>:"|?*'.includes(ch) ? '_' : ch
		})
		.join('')
		.replace(/\.{2,}/g, '_')
		.replace(/[. ]+$/, '')
	const dot = cleaned.lastIndexOf('.')
	const stem = (dot > 0 ? cleaned.slice(0, dot) : cleaned).slice(0, 80)
	const ext = dot > 0 ? cleaned.slice(dot).slice(0, 20) : ''
	const name = `${stem || 'unnamed'}${ext}`
	// 清洗后只剩下划线/点（原名全是非法字符）也走兜底名
	return /^[_.\s]*\.[^.]*$/.test(name) || /^[_.\s]*$/.test(name) ? (ext ? `unnamed${ext}` : 'unnamed') : name
}

export interface ReferenceFilePlan {
	/** 用户可见的显示名（清洗后） */
	displayName: string
	/** 落盘文件名（可能带去重序号） */
	fileName: string
	/** 相对录制工件根的元数据路径（references/<fileName>） */
	relativePath: string
	/** 解析后的绝对路径（已验证在 dir 内） */
	absolutePath: string
}

/** 目标 dir 是否包含 target（target 为绝对路径）；逃逸返回 false */
export function isInsideDirectory(dir: string, target: string): boolean {
	const rel = relative(resolve(dir), resolve(dir, target))
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 规划上传文件的落盘位置：dir 应为 <artifactsDir>/references。
 * existingNames 为该目录已有文件名（大小写不敏感去重，Windows 文件系统语义）。
 */
export function planReferenceFileTarget(
	dir: string,
	originalName: string,
	existingNames: Iterable<string>,
): ReferenceFilePlan {
	const displayName = sanitizeReferenceFileName(originalName)
	const existing = new Set(
		Array.from(existingNames, (name) => name.toLowerCase()),
	)
	const dot = displayName.lastIndexOf('.')
	const stem = dot > 0 ? displayName.slice(0, dot) : displayName
	// 落盘名扩展名统一小写（碰撞比较已按大小写不敏感；避免跨平台出现仅大小写不同的两个文件）
	const ext = dot > 0 ? displayName.slice(dot).toLowerCase() : ''
	let fileName = `${stem}${ext}`
	let seq = 2
	while (existing.has(fileName.toLowerCase())) {
		fileName = `${stem}-${seq}${ext}`
		seq++
	}
	const absolutePath = resolve(dir, fileName)
	if (!isInsideDirectory(dir, absolutePath)) {
		throw new Error(`Reference 文件路径逃逸被拒绝：${originalName}`)
	}
	return { displayName, fileName, relativePath: `references/${fileName}`, absolutePath }
}

/**
 * 附件元数据路径 → 工件内绝对路径（回放注入用）。
 * 防逃逸的第二道关口：解析结果必须落在 <artifactsDir>/references/ 内，否则抛错。
 */
export function resolveAttachmentPath(artifactsDir: string, path: string): string {
	const referencesDir = join(artifactsDir, 'references')
	const absolutePath = resolve(artifactsDir, path)
	if (!isInsideDirectory(referencesDir, absolutePath)) {
		throw new Error(`附件路径越界被拒绝：${path}`)
	}
	return absolutePath
}
