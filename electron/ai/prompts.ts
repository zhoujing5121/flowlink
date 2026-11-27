/**
 * Pi 提示词模板：config/prompts.json 是唯一来源。
 *
 * 加载与校验保持无 Electron 依赖（与 ai-refine 一致），便于测试直接打包。
 * 模板使用 {{key}} 占位符；缺失值在组装时立即抛错，绝不静默输出占位符。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GenerationTemplates {
	/** 录制停止后的自动清洗/分组（auto 模式）。 */
	autoSanitize: string
	/** 按用户指令生成细化工作流（refine 模式）。 */
	refine: string
}

export interface AdviceTemplates {
	/** AI 面板建议请求模板。 */
	prompt: string
	/** startAIAdvice 各场景的默认请求文案。 */
	defaults: {
		recordingComplete: string
		replayFailure: string
		materialRefinement: string
	}
}

/** Test 失败后 AI 接管（browser-use）的提示词模板。 */
export interface TakeoverTemplates {
	/** BrowserUse.create 的 instructions：能力清单与安全规则。 */
	systemInstructions: string
	/** 每个剩余步骤的任务文本模板。 */
	stepTask: string
	/** 单步失败后的重试任务模板。 */
	retryTask: string
	/** 单步两败后降级自由续跑（free-run）的 goal 任务模板。 */
	freeRunTask: string
}

export interface PromptTemplates {
	/** Pi 会话系统提示词（worker systemPromptOverride）。 */
	systemPrompt: string
	generation: GenerationTemplates
	advice: AdviceTemplates
	takeover: TakeoverTemplates
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

/** 用给定值填充 {{key}} 占位符；出现没有对应值的占位符时立即抛错。 */
export function formatTemplate(template: string, values: Record<string, string>): string {
	return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
		const value = values[key]
		if (typeof value !== 'string') {
			throw new Error(`Pi prompt template references {{${key}}}, but no value was provided.`)
		}
		return value
	})
}

function requireString(value: unknown, where: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${where} must be a non-empty string.`)
	}
	return value
}

function validateTemplates(value: unknown): PromptTemplates {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('the file must contain a JSON object.')
	}
	const root = value as Record<string, unknown>
	const generation = root.generation as Record<string, unknown> | undefined
	const advice = root.advice as Record<string, unknown> | undefined
	const defaults = advice?.defaults as Record<string, unknown> | undefined
	const takeover = root.takeover as Record<string, unknown> | undefined
	return {
		systemPrompt: requireString(root.systemPrompt, 'systemPrompt'),
		generation: {
			autoSanitize: requireString(generation?.autoSanitize, 'generation.autoSanitize'),
			refine: requireString(generation?.refine, 'generation.refine'),
		},
		advice: {
			prompt: requireString(advice?.prompt, 'advice.prompt'),
			defaults: {
				recordingComplete: requireString(
					defaults?.recordingComplete,
					'advice.defaults.recordingComplete',
				),
				replayFailure: requireString(defaults?.replayFailure, 'advice.defaults.replayFailure'),
				materialRefinement: requireString(
					defaults?.materialRefinement,
					'advice.defaults.materialRefinement',
				),
			},
		},
		takeover: {
			systemInstructions: requireString(takeover?.systemInstructions, 'takeover.systemInstructions'),
			stepTask: requireString(takeover?.stepTask, 'takeover.stepTask'),
			retryTask: requireString(takeover?.retryTask, 'takeover.retryTask'),
			freeRunTask: requireString(takeover?.freeRunTask, 'takeover.freeRunTask'),
		},
	}
}

/** 读取并校验 config 目录下的 prompts.json；缺失或格式错误时抛出面向维护者的错误。 */
export function loadPromptTemplates(configDir: string): PromptTemplates {
	const filePath = join(configDir, 'prompts.json')
	if (!existsSync(filePath)) {
		throw new Error(`Pi prompt template file not found: ${filePath}`)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(filePath, 'utf8'))
	} catch (error) {
		throw new Error(
			`Pi prompt template file is not valid JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
		)
	}
	try {
		return validateTemplates(parsed)
	} catch (error) {
		throw new Error(
			`Pi prompt template file is invalid: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
		)
	}
}
