/**
 * RR 中间表示（动作轨迹）的 schema 再导出桶：结构定义的唯一来源入口。
 *
 * 实现按域拆分在同级文件：element（元素证据链）/ variable（变量与附件）/
 * step（步骤 IR）/ flow（Flow 本体）/ template（模板）/ contract（跨字段校验）。
 * 深层导入 `../../schema/src/schema.js` 的既有使用方不受拆分影响；
 * 新代码建议直接从对应子模块导入。
 *
 * 设计约定：
 * 1. `observed` 是录制时的原始事实，回放/自愈 **不得修改**；
 * 2. `candidates` / `fingerprint` 是"解析结果"，AI 自愈可以写回（version+1）；
 * 3. 大文件（截图/DOM 快照）不进 IR，只存相对路径（crop.ref / artifact ref）；
 * 4. 敏感值永远不落明文：password 这类字段必须是 {{var}} 模板。
 */
export * from './element.js'
export * from './variable.js'
export * from './step.js'
export * from './flow.js'
export * from './template.js'
export * from './contract.js'
