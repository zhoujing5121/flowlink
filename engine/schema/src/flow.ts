/**
 * Flow 顶层 schema：环境、自愈记录与 Flow 本体。
 * schemaVersion 是磁盘数据兼容契约：升版必须经 io.ts 的显式迁移。
 */
import { z } from 'zod'

import { ReferenceFileSchema, VariableSchema } from './variable.js'
import { StepSchema } from './step.js'

export const SCHEMA_VERSION = 4

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
