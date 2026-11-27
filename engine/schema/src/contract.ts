/**
 * Flow 跨字段契约校验：检查 Zod 单字段类型无法表达的整体约束（唯一性、
 * 引用完整性、路径安全、密码模板），返回全部诊断而不在首错处中断。
 */
import { isFileReferenceType } from '../../reference/src/type-catalog.js'

import type { FrameAnchor, ElementRef, Expect } from './element.js'
import type { Flow } from './flow.js'
import type { Step } from './step.js'
import { parseTemplate } from './template.js'
import { isSafeReferenceFilePath } from './variable.js'

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
	// 1) label 重复会让用户与 AI 建议指向歧义；2) 上传文件/附件路径必须留在 references/ 内（防逃逸）。
	const labelSeen = new Set<string>()
	for (const variable of flow.variables) {
		const label = variable.label?.trim()
		if (!label) continue
		if (labelSeen.has(label)) {
			errors.push(`variables[${variable.name}]: label "${label}" 重复（label 必须唯一）`)
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
	for (const file of flow.referenceFiles) {
		if (!isSafeReferenceFilePath(file.path)) {
			errors.push(`referenceFiles[${file.id}]: path "${file.path}" 必须是 references/ 下的安全单段相对路径`)
		}
	}
	if (opts.strict) {
		// 组 id 与步骤 id 共享命名空间，在整个 Flow 内唯一（重复即拒绝，
		// 不再仅防御性取首现）；空分组不产出任何可执行步骤，一并拒绝。
		const seenIds = new Set<string>()
		/** 递归收集全部 id（组与步骤共享命名空间），发现重复或空组即记入诊断。 */
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
	/** 只收叶子步骤 id：组 id 不是 condition 分支的合法跳转目标。 */
	const collectStepIds = (list: Step[]): void => {
		for (const step of list) {
			if (step.kind === 'group') collectStepIds(step.steps)
			else stepIds.add(step.id)
		}
	}
	collectStepIds(flow.steps)
	// 递归检查所有引用并累积诊断；发现一项错误后继续遍历，避免只报告首个问题。
	/** 检查单个元素引用：候选升序、crop 路径安全，并沿 frame 链递归检查各层锚点。 */
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
	/** frame 锚点用同一套候选升序约束（锚点是 frame 链上的迷你元素引用）。 */
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
	/** 按动作类型分发检查：元素引用、closed-shadow 坐标、密码模板与分支目标完整性。 */
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
	/** expect 的元素目标同样要过 visitRef（urlChange/domSignature/download 无目标，跳过）。 */
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
