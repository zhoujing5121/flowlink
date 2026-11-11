/**
 * Step 树的展开与映射（group 是嵌套结构，执行/写回都需要按 stepId 定位）。
 *
 * stepId 约定：顶层就是 step.id；group 内的用 `/` 连接，例如 `checkout/click-pay`，
 * 保证在整个 flow 内唯一（result.json / selfHealed 用它回指）。
 */
import type { Step } from '../../schema/src/index.js'

export interface FlatStep {
	step: Step
	stepId: string
	/** Top-level group that owns this step, when it belongs to a group. */
	groupId?: string
	/** 在展开序列里的序号（artifact 目录名用） */
	index: number
	/** 嵌套深度，0 = 顶层 */
	depth: number
}

export function stepIdOf(prefix: string, id: string): string {
	return prefix.length > 0 ? `${prefix}/${id}` : id
}

/** 深度优先展开（group 不产出自身条目，只展开子步骤）；index 全局连续 */
export function flattenSteps(steps: Step[], prefix = '', depth = 0): FlatStep[] {
	const out: FlatStep[] = []
	// 使用全局展开序号作为 artifact 索引，因此会包含此前各个 group 中的步骤。
	const visit = (
		list: Step[],
		listPrefix: string,
		listDepth: number,
		ownerGroupId?: string,
	): void => {
		for (const step of list) {
			const stepId = stepIdOf(listPrefix, step.id)
			if (step.kind === 'group') {
				visit(step.steps, stepId, listDepth + 1, ownerGroupId ?? step.id)
				continue
			}
			out.push({
				step,
				stepId,
				...(ownerGroupId ? { groupId: ownerGroupId } : {}),
				index: out.length,
				depth: listDepth,
			})
		}
	}
	visit(steps, prefix, depth)
	return out
}

/** Build a validated-prefix candidate without discarding group/control-flow structure. */
export function prefixSteps(steps: Step[], executableCount: number): Step[] {
	if (!Number.isInteger(executableCount) || executableCount < 0) {
		throw new Error('executableCount 必须是非负整数')
	}
	const take = (items: Step[], limit: number): { steps: Step[]; used: number } => {
		const result: Step[] = []
		let used = 0
		for (const item of items) {
			if (item.kind === 'group') {
				if (used >= limit && item.steps.length > 0) break
				const children = take(item.steps, Math.max(0, limit - used))
				result.push({ ...structuredClone(item), steps: children.steps })
				used += children.used
				continue
			}
			if (used >= limit) break
			result.push(structuredClone(item))
			used++
		}
		return { steps: result, used }
	}
	const result = take(steps, executableCount).steps
	const groupIds = new Set(
		result
			.filter((step): step is Extract<Step, { kind: 'group' }> => step.kind === 'group')
			.map((group) => group.id),
	)
	for (const group of result) {
		if (group.kind !== 'group') continue
		const last = group.steps.at(-1)
		if (last?.kind !== 'condition') continue
		if (last.trueGroupId && !groupIds.has(last.trueGroupId)) delete last.trueGroupId
		if (last.falseGroupId && !groupIds.has(last.falseGroupId)) delete last.falseGroupId
	}
	return result
}

/** 不可变地映射每个非 group step（保留 group 结构） */
export function mapSteps(
	steps: Step[],
	fn: (step: Step, stepId: string) => Step,
	prefix = '',
): Step[] {
	return steps.map((step) => {
		const stepId = stepIdOf(prefix, step.id)
		if (step.kind === 'group') {
			return { ...step, steps: mapSteps(step.steps, fn, stepId) }
		}
		return fn(step, stepId)
	})
}

/** flow 里是否出现某种 step（用于提前决定策略，例如有没有 dialog 步骤 → 对话框手动模式） */
export function hasStepKind(steps: Step[], kind: Step['kind']): boolean {
	for (const step of steps) {
		if (step.kind === kind) return true
		if (step.kind === 'group' && hasStepKind(step.steps, kind)) return true
	}
	return false
}

/** 按 stepId 找到 step（找不到返回 undefined） */
export function findStep(steps: Step[], stepId: string, prefix = ''): Step | undefined {
	for (const step of steps) {
		const id = stepIdOf(prefix, step.id)
		if (step.kind === 'group') {
			const found = findStep(step.steps, stepId, id)
			if (found) return found
			continue
		}
		if (id === stepId) return step
	}
	return undefined
}
