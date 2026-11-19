/**
 * AI 接管续跑（browser-use）：Test 回放失败后由用户触发，主进程用
 * @browser_use/pi agent 附着内嵌浏览器（CDP），按剩余步骤逐个执行。
 *
 * 边界（docs/archive/plan-test-failure-ai-takeover-browser-use.md + 强化计划
 * docs/archive/plan-ai-takeover-hardening.md）：
 * - 只产生运行时执行轨迹与 artifact，绝不写回源 Flow（observed 不可变）。
 * - secret 变量只经 sensitiveData 通道（SDK 脱敏），不进任务文本/日志/artifact；
 *   剩余步骤引用了缺失值的 secret 变量时，接管开始前直接报错。
 * - 分支感知：接管前按执行器同款路由语义求值网关 condition，决定线性子序列，
 *   被跳过的组报 skip；condition 步骤不交给 agent「执行」。
 * - 步骤完成 = agent 调用 mark_step_done 工具 + typed 结果 done=true 双门槛；
 *   单步两败后降级 free-run（剩余步骤合并为 goal 任务，完成即报）。
 * - mode='single'：AI 单步接管——只执行失败的那一步，成功后由渲染端发起
 *   playback:run resumeFromStepIndex 恢复程序回放；两败不降级 free-run（交还编排层）。
 * - manual 步骤暂停等待用户确认（复用 playback:userOperation 通道）。
 * - 每步成功后由主进程回传元素证据（a11y/交互摘要），写入 ai-takeover.json。
 * - 护栏：总时长 15 min、每步 1 次重试、AbortController 随 playback:stop 触发。
 */
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { BrowserUse, Type, type AgentTool } from '@browser_use/pi'
// 嵌套的 pi-ai（@browser_use/pi 锁定 0.85.x；顶层 1.x 属于 pi-coding-agent，二者不通用）。
// 相对路径引入并由 esbuild 打包进主包；npm 锁文件保证该嵌套路径稳定。
import { createModels, createProvider } from '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/index.js'
import { openAICompletionsApi } from '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js'

import { makeId, type Assertion, type ElementRef, type Flow, type Step } from '../engine/schema/src/index.js'
import { defaultVariables, renderTemplateValue } from '../engine/executor/src/template.js'
import { flattenSteps, type FlatStep } from '../engine/executor/src/steps.js'
import { collectTemplateRefs } from './ai-refine.js'
import { formatTemplate, type TakeoverTemplates } from './prompts.js'

const execFile = promisify(execFileCallback)

export interface TakeoverModelConfig {
	provider: string
	model: string
	baseUrl?: string
	apiKey: string
}

export interface AiTakeoverStepEvent {
	seq: number
	stepIndex: number
	/** 步骤的引擎 stepId（group 前缀形式，如 g2/click-pay）；渲染端按它精确对齐进度。 */
	stepId?: string
	note: string
	ok: boolean
	error?: string
	/** 网关 condition 路由跳过的步骤（语义对齐执行器的 skip 报告）。 */
	skipped?: boolean
	/** free-run 降级模式中完成的步骤。 */
	freeRun?: boolean
	/** manual 步骤由用户确认完成（非 agent 执行，不带 AI 徽标）。 */
	manual?: boolean
}

/** 主进程抓取的页面元素证据（repair 重锚定用；不含任何输入值/secret）。 */
export interface TakeoverEvidenceNode {
	tag: string
	role?: string
	name?: string
	testid?: string
	id?: string
	text?: string
}

export interface TakeoverEvidencePage {
	url: string
	title?: string
	nodes: TakeoverEvidenceNode[]
}

export interface TakeoverEvidence {
	pages: TakeoverEvidencePage[]
}

/** 网关 condition 的本地求值结果；null = 求值失败（保守线性继续）。 */
export interface GateEvaluation {
	matches: boolean
	note: string
}

export interface AiTakeoverDoneEvent {
	ok: boolean
	completed: number[]
	remaining: number[]
	summary: string
	artifactDir: string
	/** 本次接管模式：remaining=接管剩余全部；single=只执行失败的一步（执行器随后 resume）。 */
	mode: TakeoverMode
}

/**
 * 接管模式：
 * - remaining：接管 fromStepIndex 起的全部剩余步骤（旧全量路径，单步两败可降级 free-run）。
 * - single：只执行 fromStepIndex 这一步（AI 单步接管；成功后由渲染端发起
 *   playback:run resumeFromStepIndex 恢复程序回放）。单步两败不触发 free-run
 *   ——free-run 属于全量模式的降级，单步模式的失败交还编排层决策。
 */
export type TakeoverMode = 'remaining' | 'single'

export interface StartAiTakeoverDeps {
	cdpUrl: string
	artifactsRoot: string
	modelConfig: TakeoverModelConfig
	templates: TakeoverTemplates
	/** 与 Pi worker 相同的代理模式；接管 agent 的模型请求走主进程 fetch。 */
	proxy:
		| { mode: 'environment' }
		| { mode: 'system' }
		| { mode: 'explicit'; url: string }
	/** system 模式下由主进程用 Electron resolveProxy 解析（保持本模块无 Electron 依赖）。 */
	resolveSystemProxy: (url: string) => Promise<string>
	/**
	 * 网关 condition 本地求值（执行器同款 evaluateAssertion，由 main.ts 以
	 * 依赖注入提供；返回 null 表示无法求值，接管保守线性继续）。
	 */
	evaluateGateCondition?: (
		assertion: Assertion,
		target: ElementRef | undefined,
	) => Promise<GateEvaluation | null>
	/** manual 步骤接管时暂停等用户确认（复用 playback:userOperation 通道）。 */
	waitForUserOperation?: (opts: {
		stepId: string
		prompt: string
		signal: AbortSignal
	}) => Promise<void>
	/** 每步成功后由主进程抓当前打开页面的元素证据摘要。 */
	captureEvidence?: () => Promise<TakeoverEvidence | null>
	onStep: (event: AiTakeoverStepEvent) => void
	onDone: (event: AiTakeoverDoneEvent) => void
}

export interface StartAiTakeoverOptions {
	flow: Flow
	fromStepIndex: number
	variables: Record<string, string>
	/** 缺省 remaining（接管剩余全部）；single 见 TakeoverMode 注释。 */
	mode?: TakeoverMode
	failureSummary?: string
	deps: StartAiTakeoverDeps
}

const TOTAL_BUDGET_MS = 15 * 60_000
const STEP_MAX_STEPS = 14
const STEP_TIMEOUT_MS = 150_000
/** free-run 降级（goal 模式）单次 agent 运行的护栏；仍受总预算约束。 */
const FREE_RUN_MAX_STEPS = 60
const FREE_RUN_TIMEOUT_MS = 420_000
/** 网关路由虚拟遍历的组访问上限（镜像执行器 FLOW_LOOP_LIMIT = 3）。 */
const GATE_GROUP_VISIT_LIMIT = 3

let activeTakeover: Promise<void> | null = null
let activeAbort: AbortController | null = null
/** 路由求值阶段的「启动中」标记：activeTakeover 尚未就位前也拒绝二次启动。 */
let takeoverStarting = false

export function aiTakeoverInProgress(): boolean {
	return activeTakeover !== null || takeoverStarting
}

/** playback:stop 调用：中止接管并等待收尾（agent.close 不会动内嵌浏览器）。 */
export async function abortAiTakeover(): Promise<void> {
	activeAbort?.abort()
	if (activeTakeover) await activeTakeover.catch(() => undefined)
}

/** Electron 主进程里优先让 REPL worker 跑在系统 Node 上（≥22.19）；找不到则回退 electron.exe。 */
async function preferSystemNodeWorker(): Promise<void> {
	if (!process.versions.electron || process.env.BROWSER_USE_NODE) return
	try {
		const { stdout } = await execFile('node', ['-p', 'process.versions.node'], { timeout: 4_000 })
		const [major, minor] = stdout.trim().split('.').map(Number)
		if (Number.isFinite(major) && (major > 22 || (major === 22 && minor >= 19))) {
			process.env.BROWSER_USE_NODE = 'node'
		}
	} catch {
		/* 系统无 Node：SDK 回退 process.execPath（Electron），启动时验证 */
	}
}

let proxyDispatcherKey: string | undefined

/**
 * 为接管 agent 的模型请求配置 undici 全局 dispatcher（镜像 Pi worker 的
 * 代理逻辑：environment/system/explicit 三态）。只影响主进程 fetch。
 */
async function applyProxyDispatcher(
	proxy: StartAiTakeoverDeps['proxy'],
	baseUrl: string,
	resolveSystemProxy: (url: string) => Promise<string>,
): Promise<void> {
	const undici = await import('undici')
	const setDispatcher = (key: string, dispatcher: import('undici').Dispatcher): void => {
		if (proxyDispatcherKey === key) return
		undici.setGlobalDispatcher(dispatcher)
		proxyDispatcherKey = key
	}
	if (proxy.mode === 'environment') {
		setDispatcher('environment', new undici.EnvHttpProxyAgent())
		return
	}
	if (proxy.mode === 'explicit') {
		const url = new URL(proxy.url)
		if (url.protocol === 'socks5:') {
			setDispatcher(`explicit:${url.href}`, new undici.Socks5ProxyAgent(url))
			return
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('--pi-proxy must use http://, https://, or socks5://.')
		}
		setDispatcher(`explicit:${url.href}`, new undici.ProxyAgent(url.href))
		return
	}
	const rules = await resolveSystemProxy(baseUrl)
	const route = rules.split(';')[0]?.trim()
	if (!route) throw new Error('Windows returned no system proxy route for the takeover model endpoint.')
	if (route.toUpperCase() === 'DIRECT') {
		setDispatcher(`system:${route}`, new undici.Agent())
		return
	}
	const [type, address] = route.split(/\s+/, 2)
	if (!type || !address) throw new Error('Windows returned an unsupported system proxy route.')
	const upper = type.toUpperCase()
	if (upper === 'SOCKS5') setDispatcher(`system:${route}`, new undici.Socks5ProxyAgent(`socks5://${address}`))
	else if (upper === 'PROXY' || upper === 'HTTP') setDispatcher(`system:${route}`, new undici.ProxyAgent(`http://${address}`))
	else if (upper === 'HTTPS') setDispatcher(`system:${route}`, new undici.ProxyAgent(`https://${address}`))
	else throw new Error(`Windows returned an unsupported system proxy type: ${type}.`)
}

function buildModelsCollection(config: TakeoverModelConfig) {
	if (!config.baseUrl) {
		throw new Error(
			`AI takeover needs provider "${config.provider}" with a baseUrl in config/models.json.`,
		)
	}
	const models = createModels()
	models.setProvider(
		createProvider({
			id: config.provider,
			name: config.provider,
			baseUrl: config.baseUrl,
			auth: {
				apiKey: {
					name: 'FlowLink Pi credentials',
					resolve: async () => ({ auth: { apiKey: config.apiKey }, source: 'flowlink pi-auth' }),
					check: async () => ({ type: 'api_key' as const, source: 'flowlink pi-auth' }),
				},
			},
			models: [
				{
					id: config.model,
					name: config.model,
					api: 'openai-completions' as const,
					provider: config.provider,
					baseUrl: config.baseUrl,
					reasoning: false,
					input: ['text' as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			],
			api: openAICompletionsApi(),
		}),
	)
	return models
}

/* ---------------- 步骤投影：给 agent 的可读定义（含非 secret 变量渲染） ---------------- */

const VARIABLE_RE = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g

function truncateText(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function safeRender(value: string, vars: Record<string, string>): string {
	try {
		return renderTemplateValue(value, vars)
	} catch {
		return value
	}
}

function renderValue(value: string, vars: Record<string, string>, secrets: Set<string>): string {
	const rendered = safeRender(value, vars)
	return rendered.replace(VARIABLE_RE, (match, name: string) =>
		secrets.has(name) ? `<secret "${name}" - fill with fillSecret("${name}", backendNodeId, page)>` : match,
	)
}

function describeTarget(ref: ElementRef | undefined): string {
	if (!ref) return 'the page'
	const tag = ref.observed?.tag ?? 'element'
	const name = ref.fingerprint?.accessibleName || ref.observed?.text || ref.description
	const hints = (ref.candidates ?? [])
		.slice(0, 3)
		.map((candidate) => {
			const value =
				typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value ?? null)
			return `${candidate.kind}=${truncateText(value, 60)}`
		})
		.join(' | ')
	return `${tag}${name ? ` "${truncateText(name, 40)}"` : ''}${hints ? ` (${hints})` : ''}`
}

function expectText(step: Step): string {
	const expect = (step as { expect?: { kind: string; pattern?: string; to?: string } }).expect
	if (!expect) return ''
	if (expect.kind === 'urlChange') return `; expect the URL to match ${expect.pattern ?? '(pattern)'}`
	if (expect.kind === 'textChange') return `; expect its text to become "${expect.to ?? ''}"`
	if (expect.kind === 'visible') return '; expect it to be visible'
	return `; expect ${expect.kind}`
}

/** v1 不交给 agent 的步骤：遇到即中止接管（剩余步骤保持 pending）。
 *  openTab/switchTab/closeTab 已解锁——browser-use agent 具备标签页能力，
 *  投影里给出明确语义（agent 会用真实标签页操作完成）。 */
const UNSUPPORTED_KINDS = new Set(['upload', 'script'])

function projectStepText(step: Step, vars: Record<string, string>, secrets: Set<string>): string {
	const label = step.label ? `"${step.label}"` : '(no recorded label)'
	let detail = ''
	switch (step.kind) {
		case 'navigate':
			detail = `Open ${renderValue(step.url, vars, secrets)}`
			break
		case 'click':
			detail = `Click ${describeTarget(step.target)}${step.button && step.button !== 'left' ? ` (${step.button} button)` : ''}`
			break
		case 'input':
			detail = `Type into ${describeTarget(step.target)}: ${renderValue(step.value, vars, secrets)}`
			break
		case 'select': {
			const values = Array.isArray(step.value) ? step.value : [step.value]
			detail = `Choose ${values.map((v) => renderValue(String(v), vars, secrets)).join(', ')} in ${describeTarget(step.target)}`
			break
		}
		case 'key':
			detail = `Press ${step.key}${step.modifiers?.length ? ` with ${step.modifiers.join('+')}` : ''}`
			break
		case 'hover':
			detail = `Hover ${describeTarget(step.target)}`
			break
		case 'scroll':
			detail = step.to ? `Scroll to the ${step.to} of the page` : 'Scroll by the recorded amount'
			break
		case 'drag':
			detail = `Drag ${describeTarget(step.from)} to ${describeTarget(step.to?.target)}`
			break
		case 'wait':
			if (step.condition === 'userOperation') {
				detail = 'Wait for the user to operate manually (NOT automatable)'
			} else if (step.condition === 'timeout' || step.condition === 'networkIdle') {
				detail = `Wait for ${step.condition}${step.ms ? ` (${step.ms} ms)` : ''}`
			} else {
				detail = `Wait for condition ${step.condition}`
			}
			break
		case 'assert':
		case 'condition': {
			const assertion = step.assertion as { kind: string } | undefined
			detail = `Check ${assertion?.kind ?? 'assertion'} on ${describeTarget((step as { target?: ElementRef }).target)}`
			break
		}
		case 'extract':
			detail = `Read ${step.prop ?? 'text'} from ${describeTarget(step.target)} into variable "${step.into ?? ''}"`
			break
		case 'dialog':
			detail = `Handle the browser dialog: ${step.action ?? 'accept'}${step.promptText !== undefined ? `, typing "${renderValue(step.promptText, vars, secrets)}"` : ''}`
			break
		case 'openTab':
			detail = `Open a new browser tab${step.url ? ` to ${renderValue(step.url, vars, secrets)}` : ''} and make it the active tab`
			break
		case 'switchTab':
			detail =
				step.index === undefined
					? 'Switch to the tab this step was recorded on and continue working there'
					: `Switch to tab ${step.index + 1} (1-based tab number, in creation order) and continue working there`
			break
		case 'closeTab':
			detail =
				step.index === undefined
					? 'Close the current tab; the previously open tab becomes active'
					: `Close tab ${step.index + 1} (1-based tab number, in creation order); the previously open tab becomes active`
			break
		default:
			detail = `${step.kind} step`
			break
	}
	const pageNote = (step as { page?: number }).page !== undefined ? ` (page/tab ${(step as { page?: number }).page})` : ''
	return `- kind=${step.kind} label=${label} :: ${detail}${expectText(step as Step)}${pageNote}`
}

/** 从 Flow 证据收集主机名（导航护栏 + secret 域名限定共用）。 */
function collectHosts(flow: Flow, vars: Record<string, string>): string[] {
	const hosts = new Set<string>()
	const addUrl = (raw: string | undefined): void => {
		if (!raw) return
		try {
			hosts.add(new URL(safeRender(raw, vars)).host.toLowerCase())
		} catch {
			/* 模板或非 URL，忽略 */
		}
	}
	addUrl(flow.meta.env.startUrl)
	for (const { step } of flattenSteps(flow.steps)) {
		if (step.kind === 'navigate') {
			addUrl(step.url)
			addUrl((step as { previousUrl?: string }).previousUrl)
		}
	}
	hosts.delete('')
	return [...hosts]
}

/* ---------------- 接管主体 ---------------- */

interface StepRecord {
	seq: number
	stepIndex: number
	ok: boolean
	note: string
	evidence?: string
	error?: string
	agentSteps?: number
	usageTotalTokens?: number
	durationMs: number
	/** 网关路由跳过（非 agent 执行）。 */
	skipped?: boolean
	/** manual 步骤（用户确认完成，非 agent 执行）。 */
	manual?: boolean
	/** free-run 降级模式中完成。 */
	freeRun?: boolean
	/** 主进程回传的元素证据（repair 重锚定用）。 */
	evidencePages?: TakeoverEvidencePage[]
}

/** 接管前「跑一遍路由」的结果：选定子序列 + 被跳过步骤 + 网关决策记录。 */
interface RoutingPlan {
	selected: FlatStep[]
	skipped: Array<{ step: FlatStep; reason: string }>
	gateNotes: string[]
}

/**
 * 分支感知路由（镜像 engine/executor/src/run.ts 的 branchCursor 语义）：
 * 从 fromStepIndex 起虚拟遍历扁平步骤，遇到 condition 就用注入的
 * evaluateGateCondition 本地求值并跳组；condition 步骤本身不进入选定序列。
 * 求值失败 → 保守线性继续（不跳任何组），并在 gateNotes 里注明。
 * 组访问上限镜像执行器 FLOW_LOOP_LIMIT（3 次），超出即停止规划。
 */
async function planRouting(
	flow: Flow,
	fromStepIndex: number,
	evaluateGate: StartAiTakeoverDeps['evaluateGateCondition'],
): Promise<RoutingPlan> {
	const flat = flattenSteps(flow.steps)
	const selected: FlatStep[] = []
	const skipped: Array<{ step: FlatStep; reason: string }> = []
	const gateNotes: string[] = []

	// 顶层 group 起点 → 扁平下标（与 run.ts 的 groupStartIndices 同构）。
	const stepIndexById = new Map<string, number>()
	flat.forEach((item, index) => {
		if (item.step.id && !stepIndexById.has(item.step.id))
			stepIndexById.set(item.step.id, index)
	})
	const visits = new Map<string, number>()
	let previousGroupId: string | null = null

	let cursor = fromStepIndex
	while (cursor < flat.length) {
		const item = flat[cursor]!
		// 组访问计数：游标从组外进入该组（任意位置，含分支跳入）计一次（与执行器一致）。
		if (item.groupId && item.groupId !== previousGroupId) {
			const count = (visits.get(item.groupId) ?? 0) + 1
			visits.set(item.groupId, count)
			if (count > GATE_GROUP_VISIT_LIMIT) {
				gateNotes.push(
					`gate routing stopped at group "${item.groupId}": loop limit (${GATE_GROUP_VISIT_LIMIT} visits) reached`,
				)
				cursor = flat.length
				break
			}
		}
		previousGroupId = item.groupId ?? null
		if (item.step.kind === 'condition') {
			const condition = item.step as Extract<Step, { kind: 'condition' }>
			const outcome = evaluateGate
				? await evaluateGate(condition.assertion, condition.target).catch(() => null)
				: null
			if (!outcome) {
				gateNotes.push(
					`gate condition at step ${cursor + 1} could not be evaluated; continue linearly`,
				)
				cursor += 1
				continue
			}
			const targetStepId = outcome.matches ? condition.trueStepId : condition.falseStepId
			gateNotes.push(
				`gate condition at step ${cursor + 1} evaluated ${outcome.matches} (${outcome.note}); routing to ${
					targetStepId ?? 'sequential continuation'
				}`,
			)
			if (targetStepId === undefined) {
				// 缺省分支 = 顺序继续：执行组内下一步，不终止。
				cursor += 1
				continue
			}
			const branchCursor = stepIndexById.get(targetStepId)
			if (branchCursor === undefined) {
				gateNotes.push(
					`gate condition at step ${cursor + 1} referenced missing step "${targetStepId}"; continue linearly`,
				)
				cursor += 1
				continue
			}
			// 跳转目标之后的步骤补 skip（回跳不跳过任何步骤，语义同执行器）。
			const skipEnd = branchCursor >= flat.length ? flat.length : branchCursor
			for (let i = cursor + 1; i < skipEnd; i++) {
				skipped.push({
					step: flat[i]!,
					reason: `gate condition chose the ${outcome.matches ? 'true' : 'false'} branch`,
				})
			}
			if (branchCursor >= flat.length) {
				cursor = flat.length
				break
			}
			cursor = branchCursor
			continue
		}
		selected.push(item)
		cursor += 1
	}
	return { selected, skipped, gateNotes }
}

interface StepRunResult {
	status: string
	output?: { done: boolean; note: string }
	text?: string
	error?: string
	steps: number
	usage: { totalTokens: number }
}

function describeRunFailure(result: StepRunResult): string {
	if (result.error) return result.error
	const text = (result.text ?? '').trim()
	return `${result.status}${text ? `: ${truncateText(text, 240)}` : ''}`
}

export async function startAiTakeover(options: StartAiTakeoverOptions): Promise<void> {
	if (activeTakeover || takeoverStarting) throw new Error('AI takeover is already running')
	takeoverStarting = true
	try {
		await runTakeover(options)
	} finally {
		takeoverStarting = false
	}
}

async function runTakeover(options: StartAiTakeoverOptions): Promise<void> {
	const { flow, deps } = options
	const mode: TakeoverMode = options.mode === 'single' ? 'single' : 'remaining'
	const flattened = flattenSteps(flow.steps)
	const fromStepIndex = Math.max(0, Math.min(options.fromStepIndex, flattened.length - 1))
	if (!flattened.slice(fromStepIndex).length) throw new Error('No remaining steps to take over.')

	const vars = { ...defaultVariables(flow.variables ?? []), ...options.variables }
	const secretNames = new Set((flow.variables ?? []).filter((v) => v.secret).map((v) => v.name))
	const sensitiveData: Record<string, { value: string; domains: string[] }> = {}
	for (const name of secretNames) {
		if (vars[name] !== undefined) sensitiveData[name] = { value: vars[name], domains: [] }
	}
	const hosts = collectHosts(flow, vars)
	for (const entry of Object.values(sensitiveData)) entry.domains = hosts

	// abort 通道尽早可用；总预算计时从 agent 阶段开始（路由求值只需数秒）。
	const controller = new AbortController()
	activeAbort = controller

	// ---- 分支感知路由：接管前先按执行器同款语义「跑一遍路由」定子序列 ----
	// single 模式不做路由：只把 fromStepIndex 这一步交给 agent，其余步骤的
	// 恢复由渲染端用 playback:run resumeFromStepIndex（执行器 startCursor）完成。
	const routing =
		mode === 'single'
			? {
					selected: [flattened[fromStepIndex]!],
					skipped: [] as Array<{ step: FlatStep; reason: string }>,
					gateNotes: [
						`single-step mode: only step ${fromStepIndex + 1} is handed to the agent; program replay resumes from step ${fromStepIndex + 2}`,
					],
				}
			: await planRouting(flow, fromStepIndex, deps.evaluateGateCondition)

	// secret 缺失前置检查：剩余（选定子序列）步骤真的引用了未提供值的 secret
	// 变量时直接报错，避免跑到登录步才发现必然卡死。
	const { used: usedVariables } = collectTemplateRefs(routing.selected.map((item) => item.step))
	const missingSecrets = [...secretNames].filter(
		(name) => usedVariables.has(name) && !vars[name],
	)
	if (missingSecrets.length) {
		throw new Error(
			`接管无法开始：剩余步骤引用了未保存的密码变量 {${missingSecrets.join('}}, {{')}}}（Reference 页未保存对应值），登录段必然卡死。请先在 Reference 页保存后再试。`,
		)
	}

	const runId = makeId('run')
	const runDir = join(deps.artifactsRoot, flow.id, 'runs', runId)
	const records: StepRecord[] = []
	const completed: number[] = []
	const aborted = new Set<string>()
	let seq = 0

	// 被网关跳过的步骤：立即报 skip（语义对齐执行器的分支跳过报告）。
	for (const skip of routing.skipped) {
		seq += 1
		records.push({
			seq,
			stepIndex: skip.step.index,
			ok: true,
			note: skip.reason,
			skipped: true,
			durationMs: 0,
		})
		deps.onStep({
			seq,
			stepIndex: skip.step.index,
			stepId: skip.step.stepId,
			note: 'skipped by gate condition',
			ok: true,
			skipped: true,
		})
	}

	let currentGlobalIndex = fromStepIndex
	let markedEvidence: string | null = null

	const projections = routing.selected.map(({ step, stepId, index }) => ({
		step,
		stepId,
		globalIndex: index,
		text: projectStepText(step, vars, secretNames),
	}))

	/** free-run 降级：mark_step_done 放宽为「完成即报」时的收账回调。 */
	let freeRunActive = false
	let freeRunOnMark: ((globalIndex: number, evidence: string) => void) | null = null

	const markStepDoneSchema = Type.Object({
		stepIndex: Type.Number(),
		evidence: Type.String(),
	})
	const markStepDone: AgentTool<typeof markStepDoneSchema> = {
		name: 'mark_step_done',
		label: 'Mark workflow step done',
		description:
			'Mark a workflow step as completed. Only call it after the step\'s business outcome is visible on the page. Params: stepIndex (the step number from the task) and one sentence of evidence. In step-by-step mode only the current step index is accepted; in free-run (goal) mode you may report any outstanding step index as soon as you finish it.',
		parameters: markStepDoneSchema,
		executionMode: 'sequential',
		replay: 'never',
		execute: async (_id, params) => {
			if (freeRunActive) {
				const entry = projections.find(
					(candidate) =>
						candidate.globalIndex + 1 === params.stepIndex &&
						!completed.includes(candidate.globalIndex),
				)
				if (!entry) {
					return {
						content: [
							{
								type: 'text',
								text: `Step ${params.stepIndex} is not an outstanding remaining step. Use the step numbers from the task.`,
							},
						],
						details: { accepted: false },
					}
				}
				freeRunOnMark?.(entry.globalIndex, String(params.evidence ?? '').trim())
				return {
					content: [
						{
							type: 'text',
							text: 'Recorded. Continue with the next remaining step; finish with done=true when all are done.',
						},
					],
					details: { accepted: true },
				}
			}
			const expected = currentGlobalIndex + 1
			if (!Number.isInteger(params.stepIndex) || params.stepIndex !== expected) {
				return {
					content: [
						{ type: 'text', text: `Wrong step index. The current step is ${expected}; ${params.stepIndex} was given.` },
					],
					details: { accepted: false },
				}
			}
			markedEvidence = String(params.evidence ?? '').trim()
			return {
				content: [{ type: 'text', text: 'Recorded. Finish now with done=true.' }],
				details: { accepted: true },
			}
		},
	}

	const getStepDetailSchema = Type.Object({ stepIndex: Type.Number() })
	const getStepDetail: AgentTool<typeof getStepDetailSchema> = {
		name: 'get_step_detail',
		label: 'Get step detail',
		description:
			'Get the full recorded definition of a remaining workflow step by its step number (as given in the task).',
		parameters: getStepDetailSchema,
		executionMode: 'sequential',
		replay: 'never',
		execute: async (_id, params) => {
			const entry = projections.find((p) => p.globalIndex + 1 === params.stepIndex)
			const text = entry
				? `Step ${entry.globalIndex + 1} (id=${entry.stepId}):\n${entry.text}`
				: `Unknown step ${params.stepIndex}.`
			return { content: [{ type: 'text', text }], details: {} }
		},
	}

	const failureContext = `Replay context: the workflow "${flow.title}" stopped at step ${fromStepIndex + 1}${options.failureSummary ? ` with failure: ${truncateText(options.failureSummary, 400)}` : ''}. The browser still holds that state; continue from there.${
		routing.gateNotes.length
			? ` Routing decisions made before takeover (gate conditions evaluated locally, skipped groups are NOT yours to perform): ${routing.gateNotes.join('; ')}.`
			: ''
	}`

	const run = (async () => {
		const deadline = setTimeout(() => controller.abort(), TOTAL_BUDGET_MS)
		let agent: Awaited<ReturnType<typeof BrowserUse.create>> | null = null
		try {
			await preferSystemNodeWorker()
			if (!deps.modelConfig.baseUrl) {
				throw new Error(
					`AI takeover needs provider "${deps.modelConfig.provider}" with a baseUrl in config/models.json.`,
				)
			}
			await applyProxyDispatcher(deps.proxy, deps.modelConfig.baseUrl, deps.resolveSystemProxy)
			await mkdir(join(runDir, 'agent-workspace'), { recursive: true })

			const resultSchema = Type.Object({
				done: Type.Boolean({
					description: 'true only when this step\'s business outcome is visible on the page',
				}),
				note: Type.String({ description: 'one-sentence user-facing note in the step labels\' language' }),
			})

			let agentStarted = false
			let previousNote = ''
			let summary = ''
			// 剩余步骤全部被网关跳过时 projections 为空：不起 agent，直接收尾。
			if (projections.length) {
				agent = await BrowserUse.create({
					model: `${deps.modelConfig.provider}/${deps.modelConfig.model}`,
					models: buildModelsCollection(deps.modelConfig),
					browser: { kind: 'chrome', cdpUrl: deps.cdpUrl },
					workspace: join(runDir, 'agent-workspace'),
					instructions: deps.templates.systemInstructions,
					tools: [markStepDone, getStepDetail],
					sensitiveData,
					...(hosts.length ? { allowedDomains: hosts } : {}),
					telemetry: false,
					redact: Object.values(sensitiveData).map((entry) => entry.value),
					highlightActions: true,
					operationTimeoutMs: 15_000,
					cellTimeoutMs: 30_000,
					modelTimeoutMs: 180_000,
				})
			}

			let enterFreeRun = false
			for (const entry of projections) {
				if (controller.signal.aborted) break
				currentGlobalIndex = entry.globalIndex
				markedEvidence = null

				if (entry.step.kind === 'wait' && entry.step.condition === 'userOperation') {
					aborted.add(`step ${entry.globalIndex + 1} waits for a manual user operation`)
					break
				}
				if (UNSUPPORTED_KINDS.has(entry.step.kind)) {
					aborted.add(`step ${entry.globalIndex + 1} (${entry.step.kind}) cannot be automated by the AI takeover (upload/script steps need a dedicated channel)`)
					break
				}
				if ((entry.step as { execution?: string }).execution === 'manual') {
					// 人工步骤：不由 agent 代执行，暂停等用户在内嵌浏览器完成并确认。
					if (!deps.waitForUserOperation) {
						aborted.add(`step ${entry.globalIndex + 1} is a manual step but no user-operation channel is available`)
						break
					}
					const manualStart = Date.now()
					try {
						await deps.waitForUserOperation({
							stepId: entry.stepId,
							prompt: entry.step.label ?? '请人工完成该步骤，然后继续。',
							signal: controller.signal,
						})
					} catch (err) {
						if (controller.signal.aborted) break
						aborted.add(`step ${entry.globalIndex + 1} manual confirmation failed: ${(err as Error).message}`)
						break
					}
					seq += 1
					records.push({
						seq,
						stepIndex: entry.globalIndex,
						ok: true,
						note: 'manual step confirmed by the user',
						manual: true,
						durationMs: Date.now() - manualStart,
					})
					completed.push(entry.globalIndex)
					deps.onStep({
						seq,
						stepIndex: entry.globalIndex,
						stepId: entry.stepId,
						note: '用户已确认人工步骤完成',
						ok: true,
						manual: true,
					})
					continue
				}

				const activeAgent = agent!
				const baseValues = {
					stepIndex: String(entry.globalIndex + 1),
					stepProjection: entry.text,
				}
				const task = formatTemplate(deps.templates.stepTask, {
					...baseValues,
					failureContext: agentStarted ? '' : failureContext,
					previousOutcome: agentStarted
						? `Previous step result: ${previousNote || 'completed'}.`
						: 'The page is exactly where the replay stopped.',
				})
					.replace(/^\n+/, '')
				const runOptions = {
					schema: resultSchema,
					maxSteps: STEP_MAX_STEPS,
					timeoutMs: STEP_TIMEOUT_MS,
					signal: controller.signal,
				}

				const startedAt = Date.now()
				const raw = agentStarted
					? await activeAgent.followUp(task, { ...runOptions, schema: resultSchema })
					: await activeAgent.run(task, { ...runOptions, schema: resultSchema })
				agentStarted = true
				const result = raw as unknown as StepRunResult

				const succeeded = (res: StepRunResult): boolean =>
					res.status === 'completed' && res.output?.done === true && !!markedEvidence

				let ok = succeeded(result)
				let note = result.status === 'completed' ? (result.output?.note ?? '') : ''
				let error = ok ? undefined : describeRunFailure(result)

				if (!ok && !controller.signal.aborted) {
					const retry = formatTemplate(deps.templates.retryTask, {
						stepProjection: entry.text,
						attemptError: truncateText(error ?? 'unknown failure', 400),
					})
					const retriedRaw = await activeAgent.followUp(retry, { ...runOptions, schema: resultSchema })
					const retried = retriedRaw as unknown as StepRunResult
					ok = succeeded(retried)
					note = retried.status === 'completed' ? (retried.output?.note ?? '') : note
					error = ok ? undefined : describeRunFailure(retried)
				}

				// 每步成功后回传元素证据（主进程抓当前打开页面的摘要，无需模型配合）。
				let evidencePages: TakeoverEvidencePage[] | undefined
				if (ok) {
					const evidence = await deps.captureEvidence?.().catch(() => null)
					if (evidence?.pages.length) evidencePages = evidence.pages
				}

				seq += 1
				records.push({
					seq,
					stepIndex: entry.globalIndex,
					ok,
					note: note || markedEvidence || '',
					...(markedEvidence && ok ? { evidence: markedEvidence } : {}),
					...(error && !ok ? { error } : {}),
					agentSteps: result.steps,
					usageTotalTokens: result.usage.totalTokens,
					durationMs: Date.now() - startedAt,
					...(evidencePages ? { evidencePages } : {}),
				})
				previousNote = ok ? note || 'completed' : `failed: ${error ?? ''}`

				if (ok) {
					completed.push(entry.globalIndex)
					deps.onStep({ seq, stepIndex: entry.globalIndex, stepId: entry.stepId, note: note || markedEvidence || '', ok: true })
				} else {
					deps.onStep({
						seq,
						stepIndex: entry.globalIndex,
						stepId: entry.stepId,
						note: note || '',
						ok: false,
						...(error ? { error } : {}),
					})
					// 单步两败：不硬闯，降级 free-run（剩余步骤合并为 goal 任务自主完成）。
					// free-run 只属全量模式；single 模式的失败交还编排层（渲染端决定
					// 重试单步还是回退全量接管）。
					enterFreeRun = mode === 'remaining'
					break
				}
			}

			/* ---- free-run 降级：剩余步骤合并为 goal 任务，「完成即报」收账 ---- */
			if (enterFreeRun && agent && !controller.signal.aborted) {
				const freeEntries = projections.filter((candidate) => !completed.includes(candidate.globalIndex))
				if (freeEntries.length) {
					const stepList = freeEntries
						.map((candidate) => `Step ${candidate.globalIndex + 1}: ${candidate.text}`)
						.join('\n')
					const task = formatTemplate(deps.templates.freeRunTask, {
						previousOutcome: `Previous step result: failed: ${truncateText(previousNote, 400)}`,
						stepList,
					})
						.replace(/^\n+/, '')
					freeRunActive = true
					freeRunOnMark = (globalIndex, evidence) => {
						const entry = projections.find((candidate) => candidate.globalIndex === globalIndex)!
						seq += 1
						records.push({
							seq,
							stepIndex: globalIndex,
							ok: true,
							note: evidence || 'completed in free-run mode',
							...(evidence ? { evidence } : {}),
							freeRun: true,
							durationMs: 0,
						})
						completed.push(globalIndex)
						deps.onStep({
							seq,
							stepIndex: globalIndex,
							stepId: entry.stepId,
							note: evidence || 'completed in free-run mode',
							ok: true,
							freeRun: true,
						})
					}
					const freeStart = Date.now()
					let freeResult: StepRunResult | undefined
					let freeError: string | undefined
					try {
						const raw = await agent.followUp(task, {
							schema: resultSchema,
							maxSteps: FREE_RUN_MAX_STEPS,
							timeoutMs: FREE_RUN_TIMEOUT_MS,
							signal: controller.signal,
						})
						freeResult = raw as unknown as StepRunResult
					} catch (err) {
						// 预算尽/agent 异常也算 free-run 的正常终点；已收账的完成不丢。
						freeError = controller.signal.aborted
							? 'free-run stopped (budget or user abort)'
							: (err as Error).message
					} finally {
						freeRunActive = false
						freeRunOnMark = null
					}
					// free-run 结束后对最终现场补一次证据快照（运行中不能并发评估页面）。
					const evidencePages =
						(await deps.captureEvidence?.().catch(() => null))?.pages ?? undefined
					seq += 1
					records.push({
						seq,
						stepIndex: -1,
						ok: Boolean(freeResult?.status === 'completed') && !freeError,
						note:
							freeError ??
							(freeResult?.status === 'completed'
								? (freeResult.output?.note ?? 'free-run finished')
								: describeRunFailure(freeResult ?? { status: 'error', steps: 0, usage: { totalTokens: 0 } })),
						freeRun: true,
						agentSteps: freeResult?.steps,
						usageTotalTokens: freeResult?.usage?.totalTokens,
						durationMs: Date.now() - freeStart,
						...(evidencePages?.length ? { evidencePages } : {}),
					})
					previousNote = `free-run finished (${completed.length}/${projections.length} done)`
				}
			}

			const remainingAfter = projections
				.map((p) => p.globalIndex)
				.filter((index) => !completed.includes(index))
			const allDone = completed.length === projections.length
			const freeRunCompleted = records.filter((record) => record.freeRun && record.ok && record.stepIndex >= 0)
				.length
			const manualCompleted = records.filter((record) => record.manual).length
			const skippedNote = routing.skipped.length
				? ` ${routing.skipped.length} step(s) were skipped by gate conditions before takeover.`
				: ''
			if (mode === 'single') {
				summary = allDone
					? `Single-step AI takeover completed step ${fromStepIndex + 1}${manualCompleted ? ' (confirmed manually by the user)' : ''}. Program replay resumes from step ${fromStepIndex + 2}.`
					: controller.signal.aborted
						? `Single-step AI takeover stopped (${completed.length}/${projections.length} step completed).`
						: aborted.size
							? `Single-step AI takeover stopped before finishing: ${[...aborted][0]}.`
							: `Single-step AI takeover could not complete step ${fromStepIndex + 1}; the orchestrator decides whether to retry or fall back to a full takeover.`
			} else if (allDone) {
				summary = `AI completed all ${projections.length} remaining step(s)${
					freeRunCompleted ? ` (${freeRunCompleted} in free-run mode)` : ''
				}${manualCompleted ? ` (${manualCompleted} confirmed manually by the user)` : ''}.${skippedNote}`
			} else if (controller.signal.aborted) {
				summary = `AI takeover stopped (${completed.length}/${projections.length} remaining steps completed${
					freeRunCompleted ? `, ${freeRunCompleted} in free-run mode` : ''
				}).${skippedNote}`
			} else if (aborted.size) {
				summary = `AI takeover stopped before finishing: ${[...aborted][0]}. Completed ${completed.length}/${projections.length}${
					freeRunCompleted ? ` (${freeRunCompleted} in free-run mode)` : ''
				}.${skippedNote}`
			} else {
				summary = `AI takeover stopped after a step could not be completed. Completed ${completed.length}/${projections.length}${
					freeRunCompleted ? ` (${freeRunCompleted} in free-run mode)` : ''
				}; the rest needs manual attention.${skippedNote}`
			}
			if (routing.gateNotes.length) summary += ` Routing: ${routing.gateNotes.join('; ')}.`

			const artifact = {
				startedAt: new Date().toISOString(),
				flowId: flow.id,
				fromStepIndex,
				mode,
				model: `${deps.modelConfig.provider}/${deps.modelConfig.model}`,
				routing: {
					gates: routing.gateNotes,
					skipped: routing.skipped.map((skip) => ({
						stepId: skip.step.stepId,
						stepIndex: skip.step.index,
						reason: skip.reason,
					})),
				},
				steps: records,
				completed,
				summary,
			}
			await writeFile(join(runDir, 'ai-takeover.json'), JSON.stringify(artifact, null, '\t'), 'utf8')

			deps.onDone({
				ok: allDone,
				completed,
				remaining: remainingAfter,
				summary,
				artifactDir: runDir,
				mode,
			})
		} finally {
			clearTimeout(deadline)
			await agent?.close().catch(() => undefined)
		}
	})()

	activeTakeover = run
	try {
		await run
	} finally {
		activeTakeover = null
		activeAbort = null
	}
}

