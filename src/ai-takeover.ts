/**
 * AI 接管续跑（browser-use）：Test 回放失败后由用户触发，主进程用
 * @browser_use/pi agent 附着内嵌浏览器（CDP），按剩余步骤逐个执行。
 *
 * 边界（docs/plan-test-failure-ai-takeover-browser-use.md）：
 * - 只产生运行时执行轨迹与 artifact，绝不写回源 Flow（observed 不可变）。
 * - secret 变量只经 sensitiveData 通道（SDK 脱敏），不进任务文本/日志/artifact。
 * - 步骤完成 = agent 调用 mark_step_done 工具 + typed 结果 done=true 双门槛。
 * - 护栏：总时长 10 min、每步 1 次重试、连续失败即中止、AbortController 随
 *   playback:stop 触发。
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

import { makeId, type ElementRef, type Flow, type Step } from '../engine/schema/src/index.js'
import { defaultVariables, renderTemplateValue } from '../engine/executor/src/template.js'
import { flattenSteps } from '../engine/executor/src/steps.js'
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
	note: string
	ok: boolean
	error?: string
}

export interface AiTakeoverDoneEvent {
	ok: boolean
	completed: number[]
	remaining: number[]
	summary: string
	artifactDir: string
}

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
	onStep: (event: AiTakeoverStepEvent) => void
	onDone: (event: AiTakeoverDoneEvent) => void
}

export interface StartAiTakeoverOptions {
	flow: Flow
	fromStepIndex: number
	variables: Record<string, string>
	failureSummary?: string
	deps: StartAiTakeoverDeps
}

const TOTAL_BUDGET_MS = 10 * 60_000
const STEP_MAX_STEPS = 14
const STEP_TIMEOUT_MS = 150_000

let activeTakeover: Promise<void> | null = null
let activeAbort: AbortController | null = null

export function aiTakeoverInProgress(): boolean {
	return activeTakeover !== null
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

/** v1 不交给 agent 的步骤：遇到即中止接管（剩余步骤保持 pending）。 */
const UNSUPPORTED_KINDS = new Set(['upload', 'switchTab', 'openTab', 'closeTab', 'script'])

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
	if (activeTakeover) throw new Error('AI takeover is already running')
	const { flow, deps } = options
	const flattened = flattenSteps(flow.steps)
	const fromStepIndex = Math.max(0, Math.min(options.fromStepIndex, flattened.length - 1))
	const remaining = flattened.slice(fromStepIndex)
	if (!remaining.length) throw new Error('No remaining steps to take over.')

	const vars = { ...defaultVariables(flow.variables ?? []), ...options.variables }
	const secretNames = new Set((flow.variables ?? []).filter((v) => v.secret).map((v) => v.name))
	const sensitiveData: Record<string, { value: string; domains: string[] }> = {}
	for (const name of secretNames) {
		if (vars[name] !== undefined) sensitiveData[name] = { value: vars[name], domains: [] }
	}
	const hosts = collectHosts(flow, vars)
	for (const entry of Object.values(sensitiveData)) entry.domains = hosts

	const runId = makeId('run')
	const runDir = join(deps.artifactsRoot, flow.id, 'runs', runId)
	const records: StepRecord[] = []
	const completed: number[] = []
	const aborted = new Set<string>()

	const controller = new AbortController()
	activeAbort = controller
	const deadline = setTimeout(() => controller.abort(), TOTAL_BUDGET_MS)

	let currentGlobalIndex = fromStepIndex
	let markedEvidence: string | null = null
	let seq = 0

	const projections = remaining.map(({ step, stepId, index }) => ({
		step,
		stepId,
		globalIndex: index,
		text: projectStepText(step, vars, secretNames),
	}))

	const markStepDoneSchema = Type.Object({
		stepIndex: Type.Number(),
		evidence: Type.String(),
	})
	const markStepDone: AgentTool<typeof markStepDoneSchema> = {
		name: 'mark_step_done',
		label: 'Mark workflow step done',
		description:
			'Mark the current workflow step as completed. Only call it after the step\'s business outcome is visible on the page. Params: stepIndex (the step number from the task) and one sentence of evidence.',
		parameters: markStepDoneSchema,
		executionMode: 'sequential',
		replay: 'never',
		execute: async (_id, params) => {
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

	const failureContext = `Replay context: the workflow "${flow.title}" stopped at step ${fromStepIndex + 1}${options.failureSummary ? ` with failure: ${truncateText(options.failureSummary, 400)}` : ''}. The browser still holds that state; continue from there.`

	const run = (async () => {
		await preferSystemNodeWorker()
		if (!deps.modelConfig.baseUrl) {
			throw new Error(
				`AI takeover needs provider "${deps.modelConfig.provider}" with a baseUrl in config/models.json.`,
			)
		}
		await applyProxyDispatcher(deps.proxy, deps.modelConfig.baseUrl, deps.resolveSystemProxy)
		await mkdir(join(runDir, 'agent-workspace'), { recursive: true })
		const agent = await BrowserUse.create({
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

		const resultSchema = Type.Object({
			done: Type.Boolean({
				description: 'true only when this step\'s business outcome is visible on the page',
			}),
			note: Type.String({ description: 'one-sentence user-facing note in the step labels\' language' }),
		})

		let first = true
		let previousNote = ''
		let summary = ''
		try {
			for (const entry of projections) {
				if (controller.signal.aborted) break
				currentGlobalIndex = entry.globalIndex
				markedEvidence = null

				if (entry.step.kind === 'wait' && entry.step.condition === 'userOperation') {
					aborted.add(`step ${entry.globalIndex + 1} waits for a manual user operation`)
					break
				}
				if (UNSUPPORTED_KINDS.has(entry.step.kind)) {
					aborted.add(`step ${entry.globalIndex + 1} (${entry.step.kind}) is not automatable in this version`)
					break
				}

				const baseValues = {
					stepIndex: String(entry.globalIndex + 1),
					stepProjection: entry.text,
				}
				const task = formatTemplate(deps.templates.stepTask, {
					...baseValues,
					failureContext: first ? failureContext : '',
					previousOutcome: first
						? 'The page is exactly where the replay stopped.'
						: `Previous step result: ${previousNote || 'completed'}.`,
				})
					.replace(/^\n+/, '')
				const runOptions = {
					schema: resultSchema,
					maxSteps: STEP_MAX_STEPS,
					timeoutMs: STEP_TIMEOUT_MS,
					signal: controller.signal,
				}

				const startedAt = Date.now()
				const raw = first
					? await agent.run(task, { ...runOptions, schema: resultSchema })
					: await agent.followUp(task, { ...runOptions, schema: resultSchema })
				first = false
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
					const retriedRaw = await agent.followUp(retry, { ...runOptions, schema: resultSchema })
					const retried = retriedRaw as unknown as StepRunResult
					ok = succeeded(retried)
					note = retried.status === 'completed' ? (retried.output?.note ?? '') : note
					error = ok ? undefined : describeRunFailure(retried)
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
				})
				previousNote = ok ? note || 'completed' : `failed: ${error ?? ''}`

				if (ok) {
					completed.push(entry.globalIndex)
					deps.onStep({ seq, stepIndex: entry.globalIndex, note: note || markedEvidence || '', ok: true })
				} else {
					deps.onStep({
						seq,
						stepIndex: entry.globalIndex,
						note: note || '',
						ok: false,
						...(error ? { error } : {}),
					})
					// 单步两次尝试失败即中止：不硬闯后续步骤（现场已偏离录制预期）。
					break
				}
			}

			const remainingAfter = projections
				.map((p) => p.globalIndex)
				.filter((index) => !completed.includes(index))
			const allDone = completed.length === projections.length
			if (allDone) {
				summary = `AI completed all ${projections.length} remaining step(s).`
			} else if (controller.signal.aborted) {
				summary = `AI takeover stopped (${completed.length}/${projections.length} remaining steps completed).`
			} else if (aborted.size) {
				summary = `AI takeover stopped before finishing: ${[...aborted][0]}. Completed ${completed.length}/${projections.length}.`
			} else {
				summary = `AI takeover stopped after a step could not be completed. Completed ${completed.length}/${projections.length}; the rest needs manual attention.`
			}

			const artifact = {
				startedAt: new Date().toISOString(),
				flowId: flow.id,
				fromStepIndex,
				model: `${deps.modelConfig.provider}/${deps.modelConfig.model}`,
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
			})
		} finally {
			clearTimeout(deadline)
			await agent.close().catch(() => undefined)
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

