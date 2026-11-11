/**
 * 系统身份解析：URL → { systemId, systemName, domain }。
 *
 * 历史上有三处独立的裸主机名推导（record.ts 的 step/事件富化、flowforge-archive.ts
 * 的 systemFromUrl、src/main.ts 的 CaptureTab 构建）。统一到这里并支持别名表
 * （编程调用方 API；应用侧不配置），让同一逻辑系统在多个主机名下
 * 收敛为一个 systemId。
 *
 * 统一约定（与归档侧 systemFromUrl 语义一致，record.ts 两个调用点随之对齐）：
 * - 非 http/https URL（about:blank 等）→ browser / Browser；
 * - 无法解析的 URL → unknown-system / Unknown system。
 *
 * 纯函数：不碰浏览器 / 文件系统。
 */

export interface SystemIdentity {
	systemId: string
	systemName: string
	domain?: string
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * 解析 URL 的系统身份。
 *
 * - 主机名在 aliases 中精确命中（大小写不敏感）→
 *   `{ systemId: slug(别名), systemName: 别名, domain: 主机名 }`，
 *   使 N 个主机名收敛到同一逻辑系统；
 * - 未命中 → 今天的裸主机名行为：hostname slug + hostname 名称。
 */
export function resolveSystem(raw: string, aliases?: Record<string, string>): SystemIdentity {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return { systemId: 'unknown-system', systemName: 'Unknown system' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { systemId: 'browser', systemName: 'Browser' }
	}
	const hostname = url.hostname.toLowerCase()
	// 配置键的大小写不可信，逐条小写比较（别名表通常只有几条，无需建索引）
	let aliasName: string | undefined
	if (aliases) {
		for (const [key, name] of Object.entries(aliases)) {
			if (key.toLowerCase() === hostname) {
				aliasName = name
				break
			}
		}
	}
	if (aliasName) {
		return { systemId: slug(aliasName) || 'unknown-system', systemName: aliasName, domain: hostname }
	}
	return { systemId: slug(hostname) || 'unknown-system', systemName: hostname, domain: hostname }
}
