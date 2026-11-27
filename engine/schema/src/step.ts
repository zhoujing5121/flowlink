/**
 * 步骤 IR 的 schema：BaseStep 共享字段、全部动作类型、断言与 Step 联合。
 * 专用字段只描述 IR 数据形状；执行语义由 executor 实现，跨字段约束在 contract.ts 校验器。
 */
import { z } from 'zod'

import { CandidateSchema, ElementRefSchema, ExpectSchema, type Expect } from './element.js'

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
export const StepSchema: z.ZodType<Step, unknown> = z.lazy(() =>
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
