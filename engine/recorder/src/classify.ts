/**
 * 认证 URL 判定（SSO / 登录重定向分类）。
 *
 * 判定规则有两份使用方：record.ts 的 framenavigated 监听（录制期）和
 * flowforge-archive.ts 的 host autoRedirect 重分类（归档期）。两者必须使用同一份
 * 匹配器，否则同一份录制里 Flow 与证据旁证会对同一 URL 给出不同分类。应用侧不读
 * 任何配置文件，始终使用编译进代码的默认规则；config 参数保留给编程调用方。
 *
 * 纯函数：不碰浏览器 / 文件系统，输入输出都是普通对象，方便单测。
 */

/** 默认 IdP 主机名规则：login./logon./auth./sso./signin./identity./idp. 及其子域 */
export const DEFAULT_IDP_HOST_PATTERN = '(^|\\.)(login|logon|auth|sso|signin|identity|idp)(\\.|$)'

/** 默认登录路径规则：/login /logon /oauth /authorize /saml /signin /sso 段 */
export const DEFAULT_LOGIN_PATH_PATTERN = '/(login|logon|oauth|authorize|saml|signin|sso)([/?#]|$)'

export interface ClassificationConfig {
	idpHostPatterns?: string[]
	loginPathPatterns?: string[]
}

export interface AuthMatchers {
	host: RegExp[]
	path: RegExp[]
	/** 无效正则被跳过时逐条记录，调用方把它并入录制 warnings */
	warnings: string[]
}

/**
 * 这三类导航被推断为「机器发起的认证跳转」。它们不进入普通事件合流（否则会并进
 * 前一个动作的 expectUrl），而是由 processBatch 单独合成为带 isOptional 标记的
 * navigate 步骤，交由回放时决定执行还是跳过。原始事件始终保留在证据流里。
 */
export const AUTO_NAVIGATION_TYPES: ReadonlySet<string> = new Set([
	'sso_redirect',
	'login_redirect',
	'auto_redirect',
])

function compilePatterns(patterns: string[], label: string, warnings: string[]): RegExp[] {
	const compiled: RegExp[] = []
	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, 'i'))
		} catch (err) {
			// 坏配置不能中断录制：跳过该条并告警，其余规则照常生效。
			warnings.push(`已忽略无效的${label}（正则编译失败）：${pattern} —— ${(err as Error).message}`)
		}
	}
	return compiled
}

/**
 * 编译认证 URL 匹配器。自定义规则与默认规则取「或」；无效正则跳过并记入 warnings，
 * 永不抛错 —— 配置文件是可选增强，不能因为它让录制开不起来。
 */
export function compileAuthMatchers(config?: ClassificationConfig): AuthMatchers {
	const warnings: string[] = []
	const host = [
		new RegExp(DEFAULT_IDP_HOST_PATTERN, 'i'),
		...compilePatterns(config?.idpHostPatterns ?? [], 'IdP 主机名规则', warnings),
	]
	const path = [
		new RegExp(DEFAULT_LOGIN_PATH_PATTERN, 'i'),
		...compilePatterns(config?.loginPathPatterns ?? [], '登录路径规则', warnings),
	]
	return { host, path, warnings }
}

/** URL 是否命中认证规则：主机名对 host 规则、路径对 path 规则；解析失败返回 false。 */
export function isAuthUrl(raw: string, matchers: AuthMatchers): boolean {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return false
	}
	return (
		matchers.host.some((pattern) => pattern.test(url.hostname)) ||
		matchers.path.some((pattern) => pattern.test(url.pathname))
	)
}
