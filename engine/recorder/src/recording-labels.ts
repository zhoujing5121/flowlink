/**
 * 录制收尾的变量 label 生成：把 Reference label 启发式套用到本次录制的变量种子上。
 * 只产出显示层元数据（label/locator），机器键与模板语义不变。
 */
import { assignLabels, type LabelSeed } from '../../reference/src/index.js'
import type { Variable } from '../../schema/src/index.js'

/**
 * 录制收尾：按种子给变量统一生成业务 label（成对日期/同名去重/业务化兜底）。
 * 导出供单测使用；机器键与模板语义不变（label 只是显示层元数据）。
 */
export function applyRecordingLabels(
	variables: ReadonlyArray<Variable>,
	seeds: ReadonlyArray<LabelSeed>,
): Variable[] {
	const labels = assignLabels(seeds)
	const entryByKey = new Map(
		seeds.map((seed, index) => [seed.key, { label: labels[index]!, seed }] as const),
	)
	return variables.map((variable) => {
		const entry = entryByKey.get(variable.name)
		if (!entry) return { ...variable }
		return {
			...variable,
			label: entry.label ?? variable.label,
			locator: entry.seed.locator || variable.locator,
		}
	})
}
