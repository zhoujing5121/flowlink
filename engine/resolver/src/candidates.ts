/**
 * 将 Candidate 映射为 Playwright Locator，是 L1 唯一的定位器构造入口。
 *
 * 设计取舍：
 * - 优先使用 Playwright 官方语义定位器（getByTestId/Role/Label/Text），并提供 css/xpath 兜底；
 * - 此处不处理重试或超时，命中校验与回退顺序由 l1.ts 统一管理；
 * - xpath 可带 `xpath=...` 前缀，也可使用 `/html/body/...` 形式的裸路径。
 */
import type { Candidate } from '../../schema/src/index.js'
import type { Locator, Page } from 'playwright-core'

import type { Scope } from './types.js'

/** 从 Playwright 的 getByRole 签名中取得 role 参数类型。 */
type AriaRoleArg = Parameters<Page['getByRole']>[0]

/**
 * 判断 XPath 是否已有 Playwright 引擎前缀，或是常见的绝对路径/括号表达式。
 * 这里只决定是否补上 `xpath=`；表达式是否有效仍由 Playwright 查询时判定。
 */
export function isXPathValue(value: string): boolean {
	return value.startsWith('xpath=') || value.startsWith('/') || value.startsWith('(')
}

/**
 * 将 schema 候选转换为惰性的 Playwright Locator。
 * 本函数不查询页面、不等待或检查唯一性；这些解析策略由 L1 统一负责。
 * 只有 role 候选可使用 `{ role, name?, exact? }` 对象值，其他对象值都会报错。
 */
export function candidateLocator(scope: Scope, candidate: Candidate): Locator {
	const { kind, value } = candidate

	if (typeof value !== 'string') {
		// 结构化对象仅表达 role 的可选 name/exact 条件，不能作为其他候选类型的值。
		if (kind !== 'role') {
			throw new Error(`candidate 的对象形态只支持 role，收到 kind=${kind}`)
		}
		const opts: { name?: string; exact?: boolean } = {}
		if (value.name !== undefined) opts.name = value.name
		if (value.exact !== undefined) opts.exact = value.exact
		return scope.getByRole(value.role as AriaRoleArg, opts)
	}

	switch (kind) {
		case 'testid':
			return scope.getByTestId(value)
		case 'role':
			return scope.getByRole(value as AriaRoleArg)
		case 'label':
			return scope.getByLabel(value)
		case 'text':
			return scope.getByText(value)
		case 'css':
			return scope.locator(value)
		case 'xpath':
			return scope.locator(isXPathValue(value) ? value : `xpath=${value}`)
		default:
			throw new Error(`未知 candidate.kind: ${String(kind)}`)
	}
}

/** 返回不含页面状态的候选摘要，供解析日志和错误详情复用。 */
export function describeCandidate(candidate: Candidate): string {
	if (typeof candidate.value === 'string') {
		return `${candidate.kind}(${candidate.value})`
	}
	const name = candidate.value.name ? `, name="${candidate.value.name}"` : ''
	return `role(${candidate.value.role}${name})`
}
