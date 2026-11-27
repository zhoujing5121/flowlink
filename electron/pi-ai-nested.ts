/**
 * 嵌套 pi-ai 的深度锚点（再导出垫片）。
 *
 * @browser_use/pi 锁定的 0.85.x pi-ai 只存在于其嵌套 node_modules（顶层 1.x 属
 * pi-coding-agent，二者不通用）。该依赖必须保持 external（避免与运行时
 * pi-coding-agent 各自加载的嵌套副本形成双实例），而 external 的说明符由
 * esbuild 按字面量保留、运行时从 dist/main.js 解析——因此说明符必须是
 * `../node_modules/…`（dist 深度）。这个深度与 electron/ 根一致，但与
 * ai/ 子目录不一致；把导入收敛在本文件，ai-takeover.ts 无需感知该约束。
 * build.mjs 的 external 字面量与本文件的说明符逐字对应。
 */
export { createModels, createProvider } from '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/index.js'
export { openAICompletionsApi } from '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js'
