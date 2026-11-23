/**
 * 安全表达式子集：tokenizer + Pratt parser + 求值器 + 静态校验。
 *
 * 契约（spec: reference / Reference expressions SHALL run in a sandboxed subset）：
 * - 算术（+ - * / %）、比较（= == != < <= > >=）、逻辑（and or not 与 && || !）；
 * - 日期函数 TODAY()/DATEADD()/DATEDIFF()、文本函数 UPPER()/LOWER()/TRIM()/LEN()/CONCAT()；
 * - 按 label 引用同 Flow 其他对象；实现不得使用动态代码执行（eval/new Function）；
 * - 可静态校验：语法错误、未知名、未知函数都带位置；对象间引用禁止循环依赖。
 *
 * 纯函数，无任何 Node/IO 依赖。日期以 ISO `YYYY-MM-DD` 字符串表示（字典序即时间序）。
 */

/* ------------------------------------------------------------------ */
/* 位置与错误                                                          */
/* ------------------------------------------------------------------ */

export interface ExprLocation {
	/** 出错字符在源串中的下标（0 起） */
	index: number
	/** 出错片段长度（≥1；EOF 处为 1） */
	length: number
	/** 1 起行号 */
	line: number
	/** 1 起列号 */
	column: number
}

export class ExpressionError extends Error {
	readonly location: ExprLocation
	constructor(message: string, source: string, index: number, length = 1) {
		super(message)
		this.name = 'ExpressionError'
		this.location = locationOf(source, index, length)
	}
}

/** 把下标换算成行/列（定位展示用） */
export function locationOf(source: string, index: number, length = 1): ExprLocation {
	const clamped = Math.max(0, Math.min(index, Math.max(0, source.length)))
	const upto = source.slice(0, clamped)
	const line = (upto.match(/\n/g) ?? []).length + 1
	const lastBreak = upto.lastIndexOf('\n')
	const column = clamped - lastBreak
	return { index: clamped, length: Math.max(1, length), line, column }
}

/* ------------------------------------------------------------------ */
/* AST                                                                 */
/* ------------------------------------------------------------------ */

export type BinaryOp =
	| '+'
	| '-'
	| '*'
	| '/'
	| '%'
	| '=='
	| '!='
	| '<'
	| '<='
	| '>'
	| '>='
	| 'and'
	| 'or'

export type ExprAst =
	| { kind: 'number'; value: number }
	| { kind: 'string'; value: string }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'ident'; name: string; index: number }
	| { kind: 'call'; name: string; args: ExprAst[]; index: number }
	| { kind: 'unary'; op: '-' | 'not'; operand: ExprAst; index: number }
	| { kind: 'binary'; op: BinaryOp; left: ExprAst; right: ExprAst; index: number }

/** 白名单函数（唯一来源；求值器与静态校验共用） */
export const EXPRESSION_FUNCTIONS = [
	'TODAY',
	'DATEADD',
	'DATEDIFF',
	'ISEMPTY',
	'UPPER',
	'LOWER',
	'TRIM',
	'LEN',
	'CONCAT',
] as const

export type ExpressionFunction = (typeof EXPRESSION_FUNCTIONS)[number]

export function isExpressionFunction(name: string): name is ExpressionFunction {
	return (EXPRESSION_FUNCTIONS as readonly string[]).includes(name)
}

/** 求值期取值：字符串（含 ISO 日期）/数字/布尔 */
export type ExprValue = string | number | boolean

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

interface Token {
	kind: 'number' | 'string' | 'ident' | 'op' | 'eof'
	value: string
	index: number
	length: number
}

const OPERATORS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '&&', '||', '!', '=']

function isIdentStart(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch)
}

function isIdentPart(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch)
}

/**
 * 扫描标识符：默认吃最大 Unicode 词段；若拼上 `-词段` 后整体是已知对象名
 * （knownNames），继续延伸——使「创建日期-开始」这类带连字符的 label 成为一个
 * 引用记号。`a-b`（不在 knownNames 里）仍按减法切开。
 */
function scanIdent(source: string, start: number, knownNames: ReadonlySet<string>): Token {
	let end = start
	while (end < source.length && isIdentPart(source[end]!)) end++
	if (knownNames.size > 0) {
		let candidate = source.slice(start, end)
		for (;;) {
			// 尝试 -<词段> 延伸（仅当整体命中已知名才采纳）
			if (source[end] !== '-') break
			let extend = end + 1
			while (extend < source.length && isIdentPart(source[extend]!)) extend++
			const extended = `${candidate}-${source.slice(end + 1, extend)}`
			if (!knownNames.has(extended)) break
			candidate = extended
			end = extend
		}
	}
	return { kind: 'ident', value: source.slice(start, end), index: start, length: end - start }
}

function tokenize(source: string, knownNames: ReadonlySet<string>): Token[] {
	const tokens: Token[] = []
	let i = 0
	while (i < source.length) {
		const ch = source[i]!
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			i++
			continue
		}
		if (ch === '"' || ch === "'") {
			const quote = ch
			let j = i + 1
			let out = ''
			let closed = false
			while (j < source.length) {
				const c = source[j]!
				if (c === '\\' && j + 1 < source.length) {
					const next = source[j + 1]!
					out += next === 'n' ? '\n' : next === 't' ? '\t' : next === '\\' ? '\\' : next === quote ? quote : next
					j += 2
					continue
				}
				if (c === quote) {
					closed = true
					j++
					break
				}
				out += c
				j++
			}
			if (!closed) throw new ExpressionError('字符串未闭合', source, i, j - i)
			tokens.push({ kind: 'string', value: out, index: i, length: j - i })
			i = j
			continue
		}
		if (/[0-9]/.test(ch)) {
			let j = i
			while (j < source.length && /[0-9]/.test(source[j]!)) j++
			if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
				j++
				while (j < source.length && /[0-9]/.test(source[j]!)) j++
			}
			tokens.push({ kind: 'number', value: source.slice(i, j), index: i, length: j - i })
			i = j
			continue
		}
		if (isIdentStart(ch)) {
			const token = scanIdent(source, i, knownNames)
			tokens.push(token)
			i = token.index + token.length
			continue
		}
		const op = OPERATORS.find((candidate) => source.startsWith(candidate, i))
		if (op) {
			tokens.push({ kind: 'op', value: op, index: i, length: op.length })
			i += op.length
			continue
		}
		throw new ExpressionError(`无法识别的字符 "${ch}"`, source, i)
	}
	tokens.push({ kind: 'eof', value: '', index: source.length, length: 1 })
	return tokens
}

/* ------------------------------------------------------------------ */
/* Pratt parser                                                        */
/* ------------------------------------------------------------------ */

const PRECEDENCE: Record<string, number> = {
	or: 1,
	and: 2,
	'==': 3,
	'!=': 3,
	'<': 4,
	'<=': 4,
	'>': 4,
	'>=': 4,
	'+': 5,
	'-': 5,
	'*': 6,
	'/': 6,
	'%': 6,
}

const WORD_OPS = new Set(['and', 'or', 'not'])

interface ParseState {
	source: string
	tokens: Token[]
	pos: number
	knownNames: ReadonlySet<string>
}

function peek(state: ParseState): Token {
	return state.tokens[state.pos]!
}

function advance(state: ParseState): Token {
	const token = state.tokens[state.pos]!
	if (token.kind !== 'eof') state.pos++
	return token
}

function keywordToken(token: Token): string | undefined {
	if (token.kind !== 'ident') return undefined
	const lower = token.value.toLowerCase()
	return WORD_OPS.has(lower) ? lower : undefined
}

function parsePrimary(state: ParseState): ExprAst {
	const token = peek(state)
	if (token.kind === 'number') {
		advance(state)
		return { kind: 'number', value: Number(token.value) }
	}
	if (token.kind === 'string') {
		advance(state)
		return { kind: 'string', value: token.value }
	}
	if (token.kind === 'ident') {
		const word = keywordToken(token)
		if (word === 'not') {
			advance(state)
			const operand = parseUnary(state)
			return { kind: 'unary', op: 'not', operand, index: token.index }
		}
		if (word === 'and' || word === 'or') {
			throw new ExpressionError(`意外的关键字 "${token.value}"`, state.source, token.index, token.length)
		}
		const lower = token.value.toLowerCase()
		if (lower === 'true' || lower === 'false') {
			advance(state)
			return { kind: 'boolean', value: lower === 'true' }
		}
		advance(state)
		if (peek(state).kind === 'op' && peek(state).value === '(') {
			advance(state)
			const args: ExprAst[] = []
			if (!(peek(state).kind === 'op' && peek(state).value === ')')) {
				for (;;) {
					args.push(parseExprBody(state))
					const next = peek(state)
					if (next.kind === 'op' && next.value === ',') {
						advance(state)
						continue
					}
					break
				}
			}
			const close = advance(state)
			if (!(close.kind === 'op' && close.value === ')')) {
				throw new ExpressionError('函数调用缺少右括号 ")"', state.source, close.index, close.length)
			}
			return { kind: 'call', name: token.value, args, index: token.index }
		}
		return { kind: 'ident', name: token.value, index: token.index }
	}
	if (token.kind === 'op' && token.value === '(') {
		advance(state)
		const inner = parseExprBody(state)
		const close = advance(state)
		if (!(close.kind === 'op' && close.value === ')')) {
			throw new ExpressionError('缺少右括号 ")"', state.source, close.index, close.length)
		}
		return inner
	}
	if (token.kind === 'eof') {
		throw new ExpressionError('表达式意外结束', state.source, token.index, token.length)
	}
	throw new ExpressionError(`意外的记号 "${token.value}"`, state.source, token.index, token.length)
}

function parseUnary(state: ParseState): ExprAst {
	const token = peek(state)
	if (token.kind === 'op' && token.value === '-') {
		advance(state)
		const operand = parseUnary(state)
		return { kind: 'unary', op: '-', operand, index: token.index }
	}
	if (token.kind === 'op' && token.value === '!') {
		advance(state)
		const operand = parseUnary(state)
		return { kind: 'unary', op: 'not', operand, index: token.index }
	}
	return parsePrimary(state)
}

function parseBinary(state: ParseState, minPrecedence: number): ExprAst {
	let left = parseUnary(state)
	for (;;) {
		const token = peek(state)
		let op: string | undefined
		if (token.kind === 'op') {
			// 符号形式归一到语义运算符：&&→and、||→or、=→==
			const normalized =
				token.value === '&&' ? 'and' : token.value === '||' ? 'or' : token.value === '=' ? '==' : token.value
			if (PRECEDENCE[normalized] !== undefined) op = normalized
		} else {
			const word = keywordToken(token)
			if (word === 'and' || word === 'or') op = word
		}
		if (!op || PRECEDENCE[op]! < minPrecedence) return left
		advance(state)
		const right = parseBinary(state, PRECEDENCE[op]! + 1)
		left = { kind: 'binary', op: op as BinaryOp, left, right, index: token.index }
	}
}

function parseExprBody(state: ParseState): ExprAst {
	return parseBinary(state, 1)
}

/**
 * 解析表达式。knownNames 提供「可作为整体引用的对象 label」集合，
 * 用于带连字符 label 的整词识别；语法错误抛 ExpressionError（带位置）。
 */
export function parseExpression(source: string, knownNames: ReadonlySet<string> = new Set()): ExprAst {
	const state: ParseState = { source, tokens: tokenize(source, knownNames), pos: 0, knownNames }
	const ast = parseExprBody(state)
	const end = peek(state)
	if (end.kind !== 'eof') {
		throw new ExpressionError(`表达式末尾有多余内容 "${end.value}"`, source, end.index, end.length)
	}
	return ast
}

/** 收集 AST 中按引用名出现的全部对象引用（用于静态校验与循环依赖检测）。 */
export function extractReferences(ast: ExprAst): string[] {
	const out = new Set<string>()
	const visit = (node: ExprAst): void => {
		switch (node.kind) {
			case 'ident':
				out.add(node.name)
				break
			case 'call':
				node.args.forEach(visit)
				break
			case 'unary':
				visit(node.operand)
				break
			case 'binary':
				visit(node.left)
				visit(node.right)
				break
			default:
				break
		}
	}
	visit(ast)
	return [...out]
}

/* ------------------------------------------------------------------ */
/* 求值器                                                              */
/* ------------------------------------------------------------------ */

function isDate(value: ExprValue): boolean {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseIsoDate(value: ExprValue, fn: string): Date {
	if (!isDate(value)) {
		throw new Error(`${fn} 需要日期参数（YYYY-MM-DD），收到 "${String(value)}"`)
	}
	const date = new Date(`${value}T00:00:00Z`)
	if (Number.isNaN(date.getTime())) throw new Error(`${fn} 无法解析日期 "${String(value)}"`)
	return date
}

function formatIsoDate(date: Date): string {
	const y = date.getUTCFullYear()
	const m = String(date.getUTCMonth() + 1).padStart(2, '0')
	const d = String(date.getUTCDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

const DATE_UNITS = new Set(['day', 'week', 'month', 'year'])

function evalFunction(name: string, args: ExprValue[], now: Date): ExprValue {
	switch (name as ExpressionFunction) {
		case 'TODAY': {
			if (args.length !== 0) throw new Error('TODAY() 不接受参数')
			return formatIsoDate(now)
		}
		case 'DATEADD': {
			if (args.length !== 3) throw new Error('DATEADD(日期, 数量, 单位) 需要 3 个参数')
			const base = parseIsoDate(args[0]!, 'DATEADD')
			const amount = args[1]!
			const unit = args[2]!
			if (typeof amount !== 'number') throw new Error('DATEADD 的第 2 个参数必须是数字')
			if (typeof unit !== 'string' || !DATE_UNITS.has(unit)) {
				throw new Error('DATEADD 的单位必须是 "day"/"week"/"month"/"year"')
			}
			const result = new Date(base.getTime())
			if (unit === 'day') result.setUTCDate(result.getUTCDate() + amount)
			else if (unit === 'week') result.setUTCDate(result.getUTCDate() + amount * 7)
			else if (unit === 'month') {
				const day = result.getUTCDate()
				result.setUTCDate(1)
				result.setUTCMonth(result.getUTCMonth() + amount)
				const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
				result.setUTCDate(Math.min(day, lastDay))
			} else {
				const day = result.getUTCDate()
				result.setUTCDate(1)
				result.setUTCFullYear(result.getUTCFullYear() + amount)
				const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
				result.setUTCDate(Math.min(day, lastDay))
			}
			return formatIsoDate(result)
		}
		case 'DATEDIFF': {
			if (args.length !== 3) throw new Error('DATEDIFF(起, 止, 单位) 需要 3 个参数')
			const from = parseIsoDate(args[0]!, 'DATEDIFF')
			const to = parseIsoDate(args[1]!, 'DATEDIFF')
			const unit = args[2]!
			if (typeof unit !== 'string' || !DATE_UNITS.has(unit)) {
				throw new Error('DATEDIFF 的单位必须是 "day"/"week"/"month"/"year"')
			}
			if (unit === 'day') return Math.round((to.getTime() - from.getTime()) / 86_400_000)
			if (unit === 'week') return Math.round((to.getTime() - from.getTime()) / (7 * 86_400_000))
			const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
			return unit === 'month' ? months : Math.floor(months / 12)
		}
		case 'ISEMPTY': {
			if (args.length !== 1) throw new Error('ISEMPTY(值) 需要 1 个参数')
			return String(args[0]!) === ''
		}
		case 'UPPER': {
			if (args.length !== 1) throw new Error('UPPER(文本) 需要 1 个参数')
			return String(args[0]!).toUpperCase()
		}
		case 'LOWER': {
			if (args.length !== 1) throw new Error('LOWER(文本) 需要 1 个参数')
			return String(args[0]!).toLowerCase()
		}
		case 'TRIM': {
			if (args.length !== 1) throw new Error('TRIM(文本) 需要 1 个参数')
			return String(args[0]!).trim()
		}
		case 'LEN': {
			if (args.length !== 1) throw new Error('LEN(文本) 需要 1 个参数')
			return Array.from(String(args[0]!)).length
		}
		case 'CONCAT': {
			if (args.length < 1) throw new Error('CONCAT(…) 至少需要 1 个参数')
			return args.map((value) => String(value)).join('')
		}
		default:
			throw new Error(`未知函数 "${name}"`)
	}
}

function requireNumber(value: ExprValue, op: string): number {
	if (typeof value !== 'number') {
		throw new Error(`运算符 ${op} 需要数字，收到 "${String(value)}"`)
	}
	return value
}

function compare(op: BinaryOp, a: ExprValue, b: ExprValue): boolean {
	switch (op) {
		case '==':
			return a === b
		case '!=':
			return a !== b
		default:
			break
	}
	if (typeof a !== typeof b) {
		throw new Error(`比较 ${op} 的两侧类型不一致（${typeof a} vs ${typeof b}）`)
	}
	const left = a as string | number
	const right = b as string | number
	switch (op) {
		case '<':
			return left < right
		case '<=':
			return left <= right
		case '>':
			return left > right
		case '>=':
			return left >= right
		default:
			throw new Error(`不支持的比较运算符 ${op}`)
	}
}

export interface EvaluateOptions {
	/** TODAY() 的基准时刻；缺省 = 当前时间 */
	now?: Date
}

/**
 * 求值。scope 按「引用名」（对象 label）提供对象值。
 * 抛 Error（含中文原因）；不使用 eval/new Function。
 */
export function evaluateExpression(
	ast: ExprAst,
	scope: Readonly<Record<string, ExprValue>> = {},
	options: EvaluateOptions = {},
): ExprValue {
	const now = options.now ?? new Date()
	const visit = (node: ExprAst): ExprValue => {
		switch (node.kind) {
			case 'number':
			case 'string':
			case 'boolean':
				return node.value
			case 'ident': {
				if (!(node.name in scope)) {
					throw new Error(`引用的对象 "${node.name}" 没有可用值`)
				}
				return scope[node.name]!
			}
			case 'call': {
				const upper = node.name.toUpperCase()
				if (!isExpressionFunction(upper)) throw new Error(`未知函数 "${node.name}"`)
				return evalFunction(upper, node.args.map(visit), now)
			}
			case 'unary': {
				const value = visit(node.operand)
				if (node.op === '-') return -requireNumber(value, '-')
				if (typeof value !== 'boolean') throw new Error('not 需要布尔值')
				return !value
			}
			case 'binary': {
				const op = node.op
				if (op === 'and' || op === 'or') {
					const left = visit(node.left)
					if (typeof left !== 'boolean') throw new Error(`${op} 需要布尔值`)
					if (op === 'and' && !left) return false
					if (op === 'or' && left) return true
					const right = visit(node.right)
					if (typeof right !== 'boolean') throw new Error(`${op} 需要布尔值`)
					return right
				}
				if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
					const left = requireNumber(visit(node.left), op)
					const right = requireNumber(visit(node.right), op)
					switch (op) {
						case '+':
							return left + right
						case '-':
							return left - right
						case '*':
							return left * right
						case '/':
							if (right === 0) throw new Error('除数为 0')
							return left / right
						case '%':
							if (right === 0) throw new Error('取模数为 0')
							return left % right
						default:
							throw new Error(`不支持的运算符 ${op}`)
					}
				}
				return compare(op, visit(node.left), visit(node.right))
			}
			default:
				throw new Error('不支持的节点类型')
		}
	}
	return visit(ast)
}

/* ------------------------------------------------------------------ */
/* 静态校验                                                            */
/* ------------------------------------------------------------------ */

export interface StaticCheckOptions {
	/** 表达式可引用的对象名（label 优先，缺名回退机器键） */
	knownNames?: Iterable<string>
}

export interface StaticCheckOk {
	ok: true
	ast: ExprAst
	references: string[]
}

export interface StaticCheckFail {
	ok: false
	/** 错误信息（中文，含原因） */
	message: string
	/** 位置信息（行/列/下标） */
	location: ExprLocation
}

export type StaticCheckResult = StaticCheckOk | StaticCheckFail

/** 静态校验一条表达式：语法 / 未知对象名 / 未知函数。 */
export function checkExpression(source: string, opts: StaticCheckOptions = {}): StaticCheckResult {
	const knownNames = opts.knownNames ? new Set(opts.knownNames) : new Set<string>()
	let ast: ExprAst
	try {
		ast = parseExpression(source, knownNames)
	} catch (error) {
		if (error instanceof ExpressionError) {
			return { ok: false, message: error.message, location: error.location }
		}
		throw error
	}
	const references = extractReferences(ast)
	for (const name of references) {
		if (!knownNames.has(name)) {
			const found = /"/.test(name) ? name : `"${name}"`
			return {
				ok: false,
				message: `引用了不存在的对象 ${found}`,
				location: locationOf(source, findIdentIndex(ast, source, name), Math.max(1, name.length)),
			}
		}
	}
	// 白名单函数校验（call 名不是对象引用，单独检查）
	const callError = findUnknownCall(ast, source)
	if (callError) return callError
	return { ok: true, ast, references }
}

/** 找出 AST 中不在白名单里的函数调用（错误定位到函数名）。 */
function findUnknownCall(ast: ExprAst, source: string): StaticCheckFail | undefined {
	const stack = [ast]
	while (stack.length) {
		const node = stack.pop()!
		if (node.kind === 'call' && !isExpressionFunction(node.name.toUpperCase())) {
			return {
				ok: false,
				message: `未知函数 "${node.name}"（可用：${EXPRESSION_FUNCTIONS.join(', ')}）`,
				location: locationOf(source, node.index, Math.max(1, node.name.length)),
			}
		}
		if (node.kind === 'call') stack.push(...node.args)
		else if (node.kind === 'unary') stack.push(node.operand)
		else if (node.kind === 'binary') stack.push(node.left, node.right)
	}
	return undefined
}

/** 找出 ident 节点在源串中的下标（错误定位用；call 名不作为对象引用）。 */
function findIdentIndex(ast: ExprAst, _source: string, name: string): number {
	let found = -1
	const visit = (node: ExprAst): void => {
		if (found >= 0) return
		if (node.kind === 'ident' && node.name === name && node.index >= 0) {
			found = node.index
			return
		}
		if (node.kind === 'call') node.args.forEach(visit)
		else if (node.kind === 'unary') visit(node.operand)
		else if (node.kind === 'binary') {
			visit(node.left)
			visit(node.right)
		}
	}
	visit(ast)
	return found
}

/**
 * 循环依赖检测：entries 为「对象名 → 该对象表达式引用的对象名列表」。
 * 返回所有环（每个环是对象名数组，首尾相接）；无环返回空数组。
 */
export function detectCycles(entries: Readonly<Record<string, readonly string[]>>): string[][] {
	const color = new Map<string, 0 | 1 | 2>() // 0=未访问 1=在栈 2=完成
	const cycles: string[][] = []
	const stack: string[] = []
	const onStack = new Set<string>()
	const visit = (name: string): void => {
		color.set(name, 1)
		stack.push(name)
		onStack.add(name)
		for (const next of entries[name] ?? []) {
			if (!(next in entries)) continue
			const state = color.get(next) ?? 0
			if (state === 1) {
				const start = stack.indexOf(next)
				cycles.push([...stack.slice(start), next])
			} else if (state === 0) {
				visit(next)
			}
		}
		stack.pop()
		onStack.delete(name)
		color.set(name, 2)
	}
	for (const name of Object.keys(entries)) {
		if ((color.get(name) ?? 0) === 0) visit(name)
	}
	return cycles
}
