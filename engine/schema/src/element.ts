/**
 * 元素证据链与页面事实的 schema：observed 原始事实、候选、指纹、frame 链、
 * 裁剪引用与期望效果。设计约定（schema.ts 原文件头）：
 * 1. `observed` 是录制时的原始事实，回放/自愈 **不得修改**；
 * 2. `candidates` / `fingerprint` 是"解析结果"，AI 自愈可以写回（version+1）；
 * 3. 大文件（截图/DOM 快照）不进 IR，只存相对路径（crop.ref / artifact ref）。
 */
import { z } from 'zod'

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
	attrs: z.record(z.string(), z.string()).default({}),
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
	attributes: z.record(z.string(), z.string()).default({}),
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
