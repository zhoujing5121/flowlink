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

import { REFERENCE_TYPES, isFileReferenceType } from '../../reference/src/type-catalog.js'
import { staticValidateExpressions } from '../../reference/src/validate.js'

export const SCHEMA_VERSION = 3

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

/** Reference 校验规则（大小写/格式/正负/条件必填/公式）；表达式为安全子集，见 engine/reference */
export const VariableValidationSchema = z.object({
	/** 注入前的大小写转换；preserve/缺省 = 原样 */
	caseMode: z.enum(['preserve', 'upper', 'lower']).optional(),
	format: z
		.object({
			/** 内置预设：email / URL / 手机号 */
			preset: z.enum(['email', 'url', 'phone']).optional(),
			/** 自定义正则（JS 正则语法，按整串匹配语义由校验器决定） */
			pattern: z.string().max(500).optional(),
		})
		.optional(),
	/** 正负规则（仅 integer/decimal 类型生效） */
	sign: z.enum(['positive', 'negative', 'nonNegative', 'nonPositive']).optional(),
	/** 条件必填表达式：为真时该对象必须有值 */
	condition: z.string().max(2_000).optional(),
	/** 公式表达式：对象的值由求值产生，用户不可手填 */
	formula: z.string().max(2_000).optional(),
})
export type VariableValidation = z.infer<typeof VariableValidationSchema>

/** 上传 Reference 文件的持久化元数据：path 相对录制工件根，必须落在 references/ 内 */
export const ReferenceFileSchema = z.object({
	id: z.string().min(1),
	/** 原始显示文件名（用户可见） */
	name: z.string().min(1),
	type: z.enum(['excel', 'word', 'csv', 'md', 'file']),
	/** 相对工件根的落盘路径，形如 references/<文件名>；契约校验禁止逃逸 */
	path: z.string().min(1),
})
export type ReferenceFile = z.infer<typeof ReferenceFileSchema>

/**
 * Reference 文件路径契约：必须是 `references/` 下不含子目录、不含 `..`、
 * 不含分隔符的单段文件名（相对录制工件根）。
 */
export function isSafeReferenceFilePath(path: string): boolean {
	if (!path.startsWith('references/')) return false
	const fileName = path.slice('references/'.length)
	if (!fileName || fileName.includes('/') || fileName.includes('\\')) return false
	if (fileName.includes('..') || fileName.trim() !== fileName) return false
	return !/[\u0000-\u001f\u007f]/.test(fileName)
}

/** 文件类对象（excel/word/csv/md/file）的可选附件元数据：path 相对工件根，复用 references/ 单段防逃逸契约 */
export const VariableAttachmentSchema = z.object({
	/** 附件显示文件名 */
	name: z.string().min(1),
	/** 相对录制工件根的落盘路径，形如 references/<文件名> */
	path: z.string().min(1),
})
export type VariableAttachment = z.infer<typeof VariableAttachmentSchema>

export const VariableSchema = z.object({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, '变量名必须是合法标识符'),
	/** 业务显示名（唯一面向用户的名称）；机器键不出现在用户视野 */
	label: z.string().min(1).max(200).optional(),
	/** 封闭类型目录（engine/reference type-catalog）：url/string/integer/decimal/date/secret/excel/word/csv/md/file */
	type: z.enum(REFERENCE_TYPES).default('string'),
	defaultValue: z.string().optional(),
	/** secret 变量不会以明文出现在动作轨迹中；界面只显示 ****** */
	secret: z.boolean().default(false),
	/** 必填：回放启动前缺失则拒绝启动 */
	required: z.boolean().optional(),
	/** 校验规则（大小写/格式/正负/条件必填/公式） */
	validation: VariableValidationSchema.optional(),
	/** 关联的 L1 活动分组 id（Refine 后顶层分组）；未 Refine 录制的隐含整段活动不入此数组 */
	activities: z.array(z.string().min(1)).optional(),
	/** 文件类对象的可选附件（值即文件）；回放时解析为工件内绝对路径注入 */
	file: VariableAttachmentSchema.optional(),
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
	/**
	 * 执行方式：automated（回放时自动执行）或 manual（人工执行——回放到该步骤时
	 * 暂停，等待用户在内嵌浏览器或外部系统完成后确认再继续，复用 userOperation
	 * 的宿主确认回调）。录制与手动添加的动作步骤默认 manual；Refine 由 AI 按
	 * 业务逐步判定。省略 = automated（历史 Flow 的隐式默认，新路径不依赖省略语义）。
	 */
	execution: z.enum(['automated', 'manual']).optional(),
	/**
	 * 本步骤 expect/assert 校验的等待上限（毫秒）。缺省 5000，executor 侧钳制到
	 * [1000, 30000]；condition 步骤不走此参数（瞬时判定，0 等待）。对 isOptional
	 * 的 wait 步骤，此参数兼作「可选等待窗口」：跑满窗口条件仍未出现 → 跳过而非
	 * 失败（瞬时 SSO 页面在快网下可能已过去），由后续必选步骤裁决。
	 */
	timeout: z.number().int().positive().optional(),
	/**
	 * 回放自适应步骤：效果已自行发生时可以跳过（报告为 skip，不算失败）。
	 * navigate 由录制器对机器发起的认证跳转设置（浏览器已自行重定向则跳过）；
	 * 元素步骤（input/select/click/hover/upload/wait-element 等）可由 AI 细化或
	 * 手动设置：目标元素在短窗口内未出现则跳过，用于登录组容忍
	 * （如 SSO 记住会话时凭据字段缺失）。
	 */
	isOptional: z.boolean().optional(),
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
	/**
	 * 步骤级来源 flow（AI 细化再水化时按元素库 origin 推断：取该步骤全部
	 * $ref 中出现最多的源 flowId；无元素引用的步骤继承相邻已标注步骤）。
	 * 供 Process 图按来源分段与着色。属启发式标注；纯录制 flow 不写该字段。
	 */
	sourceFlowId: z.string().optional(),
	/**
	 * 执行前沉降：该步执行前先等页面稳定下来（可选网络空闲 + DOM 静默），
	 * 用于慢过渡（登录后首屏、提交后大刷新、跨系统跳转）之后的第一个动作。
	 * 缺省 = 不沉降，行为与不带该字段的旧 Flow 完全一致。尽力而为语义：
	 * 到达上限不报错（只记日志），失败留给后续元素等待/校验判定。
	 */
	settle: z
		.object({
			networkIdle: z.boolean().optional(),
			/** 距最后一次 DOM 变更至少这么多毫秒才算静默（100–5000）。 */
			domQuietMs: z.number().int().min(100).max(5_000).optional(),
			/** 整个沉降等待的总上限（毫秒，500–30000）；缺省 10000。 */
			maxMs: z.number().int().min(500).max(30_000).optional(),
		})
		.optional(),
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
	condition: z.enum(['element', 'networkIdle', 'timeout', 'userOperation']),
	target: ElementRefSchema.optional(),
	ms: z.number().int().min(0).optional(),
	prompt: z.string().optional(),
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

const conditionStep = BaseStepSchema.extend({
	kind: z.literal('condition'),
	target: ElementRefSchema.optional(),
	assertion: AssertionSchema,
	/** 分支跳转目标：同 Flow 内已存在步骤的 id（组 id 不是合法目标）；缺省 = 顺序继续。 */
	trueStepId: z.string().min(1).optional(),
	falseStepId: z.string().min(1).optional(),
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
	| z.infer<typeof conditionStep>
	| z.infer<typeof extractStep>
	| z.infer<typeof scriptStep>
	| z.infer<typeof dialogStep>
	| z.infer<typeof switchTabStep>
	| z.infer<typeof openTabStep>
	| z.infer<typeof closeTabStep>
	| { kind: 'group'; id: string; label: string; steps: Step[]; expect?: Expect; timeout?: number; targetSystem?: string }

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
		conditionStep,
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
			/**
			 * 目标系统标签（可选，自由文本）：标识该分组所操作的目标系统，
			 * 同值字符串即同一系统。叶子步骤的有效系统 = 最近祖先分组的标签。
			 * 必须显式声明：zod 默认 strip 未知键，不声明会在保存/加载链路被洗掉。
			 */
			targetSystem: z.string().optional(),
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
		/**
		 * AI 融合生成结果的直接来源列表（不递归展开；transitive 可按 flowId 逐级
		 * 追溯各源 flow 的 meta.sourceFlows）。纯录制 flow 不写该字段
		 * （undefined = 原生录制，Process 图按单链展示）。
		 * 必须显式声明：zod 默认 strip 未知键，不声明会在保存/加载链路被洗掉。
		 */
		sourceFlows: z
			.array(
				z.object({
					recordingId: z.string().optional(),
					flowId: z.string(),
					title: z.string(),
					flowFile: z.string().optional(),
				}),
			)
			.optional(),
	}),
	variables: z.array(VariableSchema).default([]),
	/** 上传 Reference 文件的持久化元数据（相对工件根 references/ 路径） */
	referenceFiles: z.array(ReferenceFileSchema).default([]),
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

export interface FlowContractOptions {
	/**
	 * 严格结构校验（写盘路径）：组/步骤 id 全 Flow 命名空间唯一、空分组拒绝。
	 * 旧数据加载不开启——历史遗留的重复 id/空组不阻断读取（执行器对重复 id
	 * 防御性取首现），首次保存时才暴露冲突，便于用户打开修正后再落盘。
	 */
	strict?: boolean
}

/**
 * 检查 Zod 单字段类型无法表达的整体约束，返回所有发现的问题而不在首错处中断。
 * 遍历嵌套 group、目标引用及 expect 引用，验证候选排序、裁剪路径安全、
 * closed-shadow 点击坐标以及密码值必须使用变量模板。此检查不改写输入数据。
 */
export function validateFlowContract(flow: Flow, opts: FlowContractOptions = {}): string[] {
	const errors: string[] = []
	// Reference 元数据契约（始终检查，不只 strict 模式）：
	// 1) label 重复会让表达式引用歧义；2) 表达式必须静态合法（语法/未知名/循环）；
	// 3) 上传文件路径必须留在 references/ 内（防逃逸）。
	const labelSeen = new Set<string>()
	for (const variable of flow.variables) {
		const label = variable.label?.trim()
		if (!label) continue
		if (labelSeen.has(label)) {
			errors.push(`variables[${variable.name}]: label "${label}" 重复（label 必须唯一，否则表达式引用歧义）`)
		}
		labelSeen.add(label)
	}
	// 附件契约：仅文件类对象可携带；路径必须留在 references/ 内（防逃逸）
	for (const variable of flow.variables) {
		if (!variable.file) continue
		if (!isFileReferenceType(variable.type)) {
			errors.push(`variables[${variable.name}]: 只有文件类对象（excel/word/csv/md/file）可携带附件，当前类型 ${variable.type}`)
		}
		if (!isSafeReferenceFilePath(variable.file.path)) {
			errors.push(`variables[${variable.name}]: 附件 path "${variable.file.path}" 必须是 references/ 下的安全单段相对路径`)
		}
	}
	for (const issue of staticValidateExpressions(flow.variables)) {
		errors.push(`variables[${issue.name}]（${issue.label}）: ${issue.rule} — ${issue.reason}`)
	}
	for (const file of flow.referenceFiles) {
		if (!isSafeReferenceFilePath(file.path)) {
			errors.push(`referenceFiles[${file.id}]: path "${file.path}" 必须是 references/ 下的安全单段相对路径`)
		}
	}
	if (opts.strict) {
		// 组 id 与步骤 id 共享命名空间，在整个 Flow 内唯一（重复即拒绝，
		// 不再仅防御性取首现）；空分组不产出任何可执行步骤，一并拒绝。
		const seenIds = new Set<string>()
		const visitIds = (list: Step[], where: string): void => {
			for (let i = 0; i < list.length; i++) {
				const step = list[i]!
				const at = `${where}[${i}]`
				if (seenIds.has(step.id))
					errors.push(`${at}: id "${step.id}" 重复（组/步骤共享命名空间，全 Flow 唯一）`)
				seenIds.add(step.id)
				if (step.kind === 'group') {
					if (step.steps.length === 0)
						errors.push(`${at}: 空分组被拒绝（group "${step.id}" 无任何步骤）`)
					visitIds(step.steps, `${at}.steps`)
				}
			}
		}
		visitIds(flow.steps, 'steps')
	}
	// condition 分支目标的解析域：Flow 内全部步骤 id（含各层 group 内，递归扁平化收集；
	// 组 id 不是合法目标——步骤 id 与组 id 共享命名空间且步骤 id 全局唯一）。
	const stepIds = new Set<string>()
	const collectStepIds = (list: Step[]): void => {
		for (const step of list) {
			if (step.kind === 'group') collectStepIds(step.steps)
			else stepIds.add(step.id)
		}
	}
	collectStepIds(flow.steps)
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
			case 'condition': {
				if (!step.target) errors.push(`${where}: condition assertion 缺少 target`)
				if (
					step.assertion.kind === 'text' &&
					(step.assertion.equals === undefined) === (step.assertion.contains === undefined)
				) {
					errors.push(`${where}: condition text assertion 必须且只能提供 equals 或 contains`)
				}
				if (
					step.target?.observed.attributes['type'] === 'password' &&
					step.assertion.kind === 'value'
				) {
					try {
						if (parseTemplate(step.assertion.equals).length === 0) {
							errors.push(`${where}: password 条件必须引用 secret 变量，不能保存明文`)
						}
					} catch {
						errors.push(`${where}: password 条件的变量模板语法错误`)
					}
				}
				if (step.target) visitRef(step.target, `${where}.target`)
				for (const target of [step.trueStepId, step.falseStepId]) {
					if (target && !stepIds.has(target)) {
						errors.push(`${where}: condition 引用了不存在的 step "${target}"`)
					}
				}
				break
			}
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
	flow.steps.forEach((step, index) => {
		if (step.kind === 'group') {
			step.steps.forEach((child, childIndex) =>
				visitStep(child, `steps[${index}].steps[${childIndex}]`),
			)
			return
		}
		visitStep(step, `steps[${index}]`)
	})
	return errors
}
