/**
 * RR 中间表示（动作轨迹）的 schema，是结构定义的唯一来源。
 *
 * 设计约定：
 * 1. `observed` 是录制时的原始事实，回放/自愈 **不得修改**；
 * 2. `candidates` / `fingerprint` 是"解析结果"，AI 自愈可以写回（version+1）；
 * 3. 大文件（截图/DOM 快照）不进 IR，只存相对路径（crop.ref / artifact ref）；
 * 4. 敏感值永远不落明文：password 这类字段必须是 {{var}} 模板。
 */
import { z } from 'zod'

export const SCHEMA_VERSION = 1

/** 元素/视口矩形（相对 viewport 的 CSS 像素） */
export const RectSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
})
export type Rect = z.infer<typeof RectSchema>

/** 语义候选按 score 升序排列；数值越小优先级越高，但不代表概率置信度。 */
export const CandidateSchema = z.object({
	kind: z.enum(['testid', 'role', 'label', 'text', 'css', 'xpath']),
	value: z.union([
		z.string(),
		z.object({
			role: z.string(),
			name: z.string().optional(),
			exact: z.boolean().optional(),
		}),
	]),
	score: z.number(),
	source: z.enum(['record', 'ai']).default('record'),
})
export type Candidate = z.infer<typeof CandidateSchema>

export const FingerprintSchema = z.object({
	tag: z.string(),
	role: z.string().optional(),
	accessibleName: z.string().optional(),
	/** 属性白名单（id、name、type、placeholder、aria- 与 data- 前缀属性等），已剔除动态 class */
	attrs: z.record(z.string()).default({}),
		/** 由 sha1(tag + role + name + 稳定属性) 得到的摘要。 */
	stableHash: z.string(),
	/** 从 frame 文档到元素的子节点索引链，仅作最后手段。 */
	nodePath: z.array(z.number().int().min(0)).optional(),
	/** 录制时的 CDP 节点 id，仅在同一 session 内有效。 */
	backendNodeId: z.number().int().optional(),
})
export type Fingerprint = z.infer<typeof FingerprintSchema>

/** 录制时的原始事实（不可变） */
export const ObservedFactsSchema = z.object({
	tag: z.string(),
	attributes: z.record(z.string()).default({}),
	text: z.string().optional(),
	rect: RectSchema,
	scroll: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
	viewport: z.object({ width: z.number(), height: z.number() }),
	dpr: z.number().default(1),
	recordedAt: z.number().int(),
	/** 目标位于 open/closed shadow 内；closed 模式下 Playwright/aria 无法进入，只能通过 host + innerOffset 回放。 */
	shadowRootType: z.enum(['open', 'closed']).optional(),
	/** closed shadow 内层元素相对 host 内边距框的 CSS 像素偏移，取自事件的 offsetX/offsetY。 */
	innerOffset: z.object({ x: z.number(), y: z.number() }).optional(),
})
export type ObservedFacts = z.infer<typeof ObservedFactsSchema>

/** iframe 链上的一层锚点（不含嵌套 frame，避免递归） */
export const FrameAnchorSchema = z.object({
	observed: ObservedFactsSchema,
	candidates: z.array(CandidateSchema).min(1),
	fingerprint: FingerprintSchema,
})
export type FrameAnchor = z.infer<typeof FrameAnchorSchema>

export const FrameSegmentSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('frameElement'), anchor: FrameAnchorSchema }),
	z.object({ kind: z.literal('urlPattern'), pattern: z.string() }),
	z.object({ kind: z.literal('index'), index: z.number().int().min(0) }),
])
export type FrameSegment = z.infer<typeof FrameSegmentSchema>

export const FramePathSchema = z.object({ path: z.array(FrameSegmentSchema).default([]) })
export type FramePath = z.infer<typeof FramePathSchema>

export const CropSchema = z.object({
	/** 相对 artifacts 目录的路径，禁止绝对路径 / .. */
	ref: z.string().min(1),
	dpr: z.number().default(1),
})
export type Crop = z.infer<typeof CropSchema>

/** 元素证据链：整个产品的核心 */
export const ElementRefSchema = z.object({
	observed: ObservedFactsSchema,
	candidates: z.array(CandidateSchema).min(1),
	fingerprint: FingerprintSchema,
	frame: FramePathSchema.default({ path: [] }),
	/** 用于 AI 兜底和产品界面展示。 */
	description: z.string().optional(),
	/** 邻近文本锚点，例如左侧、上方或父容器内的文本片段。 */
	nearbyText: z.array(z.string()).optional(),
	crop: CropSchema.optional(),
})
export type ElementRef = z.infer<typeof ElementRefSchema>

/** 期望效果（录制时自动推断，回放时用于校验） */
export const ExpectSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('urlChange'), pattern: z.string() }),
	z.object({ kind: z.literal('elementVisible'), target: ElementRefSchema }),
	z.object({ kind: z.literal('elementHidden'), target: ElementRefSchema }),
	z.object({ kind: z.literal('textChange'), target: ElementRefSchema, to: z.string() }),
	z.object({ kind: z.literal('domSignature'), hash: z.string(), region: z.string().optional() }),
	/** 这一步应该触发一个文件下载（文件名可选匹配） */
	z.object({ kind: z.literal('download'), filenamePattern: z.string().optional() }),
])
export type Expect = z.infer<typeof ExpectSchema>

export const VariableSchema = z.object({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '变量名必须是合法标识符'),
	type: z.enum(['string', 'text', 'email', 'date', 'number', 'secret', 'file']).default('string'),
	defaultValue: z.string().optional(),
	/** secret 变量不会以明文出现在动作轨迹中；界面只显示 ****** */
	secret: z.boolean().default(false),
	source: z.enum(['input', 'csv']).default('input'),
})
export type Variable = z.infer<typeof VariableSchema>

const PointRefSchema = z.object({
	target: ElementRefSchema.optional(),
	x: z.number().optional(),
	y: z.number().optional(),
})

const BaseStepSchema = z.object({
	id: z.string().min(1),
	label: z.string().optional(),
	timeout: z.number().int().positive().optional(),
	expect: ExpectSchema.optional(),
	/**
	 * 这一步发生在哪个标签页（0 = 录制起点页面，1 = 第一个新开的标签页…）。
	 * 不填 = 沿用上一步的标签页。多标签页流程（如"从 A 系统复制到 B 系统"）靠它表达。
	 */
	page: z.object({ index: z.number().int().min(0) }).optional(),
	// FlowForge-compatible provenance metadata: retained on the executable Flow step.
	tabId: z.string().optional(),
	systemId: z.string().optional(),
	systemName: z.string().optional(),
	pageUrl: z.string().optional(),
	sourceEventIds: z.array(z.string()).optional(),
	locatorEvidence: z.array(CandidateSchema).optional(),
	reviewRequired: z.boolean().optional(),
	reviewReason: z.string().optional(),
})

/**
 * 各动作 schema 共享 BaseStep 的标识、时限、预期结果和可选标签页上下文。
 * 专用字段只描述 IR 数据形状；执行语义由 executor 实现，跨字段约束集中在下方校验器。
 */
const navigateStep = BaseStepSchema.extend({
	kind: z.literal('navigate'),
	url: z.string(),
	navigationType: z.enum(['initial', 'user_navigate', 'user_link', 'user_redirect', 'sso_redirect', 'login_redirect', 'auto_redirect', 'popup_navigation', 'history_navigation', 'unknown_navigation']).optional(),
	previousUrl: z.string().optional(),
	navigationEvidence: z.array(z.string()).optional(),
})

const clickStep = BaseStepSchema.extend({
	kind: z.literal('click'),
	target: ElementRefSchema,
	button: z.enum(['left', 'right', 'middle']).default('left'),
	clickCount: z.number().int().min(1).max(3).default(1),
	modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).default([]),
	/** 点击位置：相对 target 内边距框的 CSS 像素；用于 closed shadow、canvas 或坐标兜底。 */
	position: z.object({ x: z.number(), y: z.number() }).optional(),
})

const inputStep = BaseStepSchema.extend({
	kind: z.literal('input'),
	target: ElementRefSchema,
	value: z.string(),
	clear: z.boolean().default(true),
})

const selectStep = BaseStepSchema.extend({
	kind: z.literal('select'),
	target: ElementRefSchema,
	value: z.union([z.string(), z.array(z.string())]),
})

const keyStep = BaseStepSchema.extend({
	kind: z.literal('key'),
	key: z.string().min(1),
	/** 组合键：['Control','Shift'] + key='A' → Ctrl+Shift+A */
	modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
	target: ElementRefSchema.optional(),
})

const hoverStep = BaseStepSchema.extend({
	kind: z.literal('hover'),
	target: ElementRefSchema,
})

const scrollStep = BaseStepSchema.extend({
	kind: z.literal('scroll'),
	target: ElementRefSchema.optional(),
	delta: z.object({ x: z.number().optional(), y: z.number().optional() }).optional(),
	to: z.enum(['top', 'bottom']).optional(),
})

const dragStep = BaseStepSchema.extend({
	kind: z.literal('drag'),
	from: ElementRefSchema,
	to: PointRefSchema,
})

const uploadStep = BaseStepSchema.extend({
	kind: z.literal('upload'),
	target: ElementRefSchema,
	files: z.array(z.string()).min(1),
})

const waitStep = BaseStepSchema.extend({
	kind: z.literal('wait'),
	condition: z.enum(['element', 'networkIdle', 'timeout']),
	target: ElementRefSchema.optional(),
	ms: z.number().int().min(0).optional(),
})

const AssertionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('visible') }),
	z.object({ kind: z.literal('hidden') }),
	z.object({
		kind: z.literal('text'),
		equals: z.string().optional(),
		contains: z.string().optional(),
	}),
	z.object({ kind: z.literal('value'), equals: z.string() }),
	z.object({ kind: z.literal('count'), equals: z.number().int().min(0) }),
])
export type Assertion = z.infer<typeof AssertionSchema>

const assertStep = BaseStepSchema.extend({
	kind: z.literal('assert'),
	target: ElementRefSchema.optional(),
	assertion: AssertionSchema,
})

const extractStep = BaseStepSchema.extend({
	kind: z.literal('extract'),
	target: ElementRefSchema,
	into: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	prop: z.enum(['text', 'value', 'attr']).default('text'),
	attr: z.string().optional(),
})

const scriptStep = BaseStepSchema.extend({
	kind: z.literal('script'),
	code: z.string().min(1),
})

/** 原生对话框（alert/confirm/prompt）：录制时用户点的是浏览器按钮，回放时必须显式确认一次 */
const dialogStep = BaseStepSchema.extend({
	kind: z.literal('dialog'),
	action: z.enum(['accept', 'dismiss']),
	promptText: z.string().optional(),
})

/** 显式切换标签页（点标签栏本身不会被页面 JS 捕获，录制器会合成这一步） */
const switchTabStep = BaseStepSchema.extend({
	kind: z.literal('switchTab'),
	index: z.number().int().min(0),
})

const openTabStep = BaseStepSchema.extend({
	kind: z.literal('openTab'),
	url: z.string().optional(),
})

const closeTabStep = BaseStepSchema.extend({
	kind: z.literal('closeTab'),
	index: z.number().int().min(0).optional(),
})

export type Step =
	| z.infer<typeof navigateStep>
	| z.infer<typeof clickStep>
	| z.infer<typeof inputStep>
	| z.infer<typeof selectStep>
	| z.infer<typeof keyStep>
	| z.infer<typeof hoverStep>
	| z.infer<typeof scrollStep>
	| z.infer<typeof dragStep>
	| z.infer<typeof uploadStep>
	| z.infer<typeof waitStep>
	| z.infer<typeof assertStep>
	| z.infer<typeof extractStep>
	| z.infer<typeof scriptStep>
	| z.infer<typeof dialogStep>
	| z.infer<typeof switchTabStep>
	| z.infer<typeof openTabStep>
	| z.infer<typeof closeTabStep>
	| { kind: 'group'; id: string; label: string; steps: Step[]; expect?: Expect; timeout?: number }

/**
 * 步骤递归通过 lazy schema 表达嵌套 group；判别字段 `kind` 决定具体动作结构。
 * group 的递归成员同样经过 StepSchema 解析，从而让嵌套内容使用一致的数据约定。
 */
export const StepSchema: z.ZodType<Step, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		navigateStep,
		clickStep,
		inputStep,
		selectStep,
		keyStep,
		hoverStep,
		scrollStep,
		dragStep,
		uploadStep,
		waitStep,
		assertStep,
		extractStep,
		scriptStep,
		dialogStep,
		switchTabStep,
		openTabStep,
		closeTabStep,
		BaseStepSchema.extend({
			kind: z.literal('group'),
			label: z.string(),
			steps: z.array(StepSchema),
		}),
	]),
)

export const EnvSchema = z.object({
	startUrl: z.string(),
	viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
	dpr: z.number().default(1),
	userAgent: z.string().optional(),
	locale: z.string().optional(),
	timezone: z.string().optional(),
})
export type Env = z.infer<typeof EnvSchema>

export const SelfHealSchema = z.object({
	stepId: z.string(),
	at: z.string(),
	level: z.enum(['L2', 'L3', 'L4']),
	from: z.string(),
	to: z.string().optional(),
	confidence: z.number().min(0).max(1).optional(),
	needsReview: z.boolean().default(false),
})
export type SelfHeal = z.infer<typeof SelfHealSchema>

export const FlowSchema = z.object({
	schemaVersion: z.literal(SCHEMA_VERSION),
	id: z.string().min(1),
	title: z.string().min(1),
	version: z.number().int().min(1).default(1),
	createdAt: z.string(),
	meta: z.object({
		env: EnvSchema,
		recorder: z.object({ name: z.string(), version: z.string() }),
	}),
	variables: z.array(VariableSchema).default([]),
	steps: z.array(StepSchema).min(1),
	stats: z
		.object({
			runs: z.number().int().min(0).default(0),
			passes: z.number().int().min(0).default(0),
			lastRunAt: z.string().optional(),
		})
		.optional(),
	selfHealed: z.array(SelfHealSchema).default([]),
})
export type Flow = z.infer<typeof FlowSchema>

/* ------------------------------------------------------------------ */
/* 契约校验（zod refine + 单测）                                        */
/* ------------------------------------------------------------------ */

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

const SAFE_REL_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/

/**
 * 检查 Zod 单字段类型无法表达的整体约束，返回所有发现的问题而不在首错处中断。
 * 遍历嵌套 group、目标引用及 expect 引用，验证候选排序、裁剪路径安全、
 * closed-shadow 点击坐标以及密码值必须使用变量模板。此检查不改写输入数据。
 */
export function validateFlowContract(flow: Flow): string[] {
	const errors: string[] = []
	// 递归检查所有引用并累积诊断；发现一项错误后继续遍历，避免只报告首个问题。
	const visitRef = (ref: ElementRef, where: string): void => {
		// 候选顺序本身决定解析优先级，同分允许保留原顺序，因此只拒绝逆序项。
		for (let i = 1; i < ref.candidates.length; i++) {
			const prev = ref.candidates[i - 1]!
			const cur = ref.candidates[i]!
			if (cur.score < prev.score) {
				errors.push(`${where}: candidates 必须按 score 升序（第 ${i} 项违反）`)
				break
			}
		}
		if (ref.crop && !SAFE_REL_PATH.test(ref.crop.ref)) {
			errors.push(`${where}: crop.ref 必须是安全的相对路径，收到 "${ref.crop.ref}"`)
		}
		for (const seg of ref.frame.path) {
			if (seg.kind === 'frameElement') visitAnchor(seg.anchor, `${where}.frame`)
		}
	}
	const visitAnchor = (a: FrameAnchor, where: string): void => {
		for (let i = 1; i < a.candidates.length; i++) {
			const prev = a.candidates[i - 1]!
			const cur = a.candidates[i]!
			if (cur.score < prev.score) {
				errors.push(`${where}: anchor candidates 必须按 score 升序`)
				break
			}
		}
	}
	const visitStep = (step: Step, where: string): void => {
		switch (step.kind) {
			case 'click':
			case 'hover': {
				visitRef(step.target, `${where}.target`)
				if (
					step.kind === 'click' &&
					step.target.observed.shadowRootType === 'closed' &&
					!step.position
				) {
					errors.push(
						`${where}: closed shadow 目标必须带 position（host + offset），否则回放无法命中内层元素`,
					)
				}
				break
			}
			case 'input': {
				visitRef(step.target, `${where}.target`)
				const type = step.target.observed.attributes['type']
				if (type === 'password') {
					try {
						const names = parseTemplate(step.value)
						if (names.length === 0)
							errors.push(`${where}: password 输入必须是 {{变量}} 模板，不能落明文`)
					} catch {
						errors.push(`${where}: password 输入的模板语法错误`)
					}
				} else {
					try {
						parseTemplate(step.value)
					} catch {
						errors.push(`${where}: value 模板语法错误`)
					}
				}
				break
			}
			case 'select':
			case 'upload':
			case 'extract':
			case 'assert':
				if ('target' in step && step.target) visitRef(step.target, `${where}.target`)
				break
			case 'key':
			case 'wait':
			case 'scroll':
				if (step.target) visitRef(step.target, `${where}.target`)
				break
			case 'drag':
				visitRef(step.from, `${where}.from`)
				if (step.to.target) visitRef(step.to.target, `${where}.to.target`)
				break
			case 'group':
				step.steps.forEach((s, i) => visitStep(s, `${where}.steps[${i}]`))
				break
			case 'dialog':
			case 'switchTab':
			case 'openTab':
			case 'closeTab':
				break
			default:
				break
		}
		if (step.expect) visitExpect(step.expect, `${where}.expect`)
	}
	const visitExpect = (e: Expect, where: string): void => {
		if (e.kind === 'urlChange' || e.kind === 'domSignature' || e.kind === 'download') return
		visitRef(e.target, `${where}.target`)
	}
	flow.steps.forEach((s, i) => visitStep(s, `steps[${i}]`))
	return errors
}
