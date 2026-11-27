/**
 * `{{变量}}` 模板的解析与渲染：录制/生成侧的引用提取、回放侧的显式失败渲染。
 * 模板语法是变量注入的唯一合法通道（密码不可落明文的契约由 contract.ts 守住）。
 */

const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * 从字符串中提取合法 `{{name}}` 引用。
 * 保留重复出现的引用顺序；未闭合括号或非法模板片段会抛错，供上层转为字段诊断。
 */
export function parseTemplate(value: string): string[] {
	const names: string[] = []
	// 按文本出现顺序收集每次引用（包括重复项）；只移除合法模板后再检查残留括号。
	const stripped = value.replace(TEMPLATE_RE, (_m, name: string) => {
		names.push(name)
		return ''
	})
	if (stripped.includes('{{') || stripped.includes('}}'))
		throw new Error('模板语法错误：存在未闭合的 {{ }}')
	return names
}

/** 渲染模板而不静默填空；缺少变量时显式失败，避免把错误输入继续送入页面。 */
export function resolveTemplate(value: string, vars: Record<string, string>): string {
	return value.replace(TEMPLATE_RE, (_m, name: string) => {
		if (!(name in vars)) throw new Error(`缺少变量 "${name}"`)
		return vars[name] as string
	})
}
