/**
 * 渲染层第三方依赖的 vendor 入口（构建产物 dist/renderer-vendor.js）。
 *
 * 渲染层没有打包器（renderer/ 下是原样加载的普通脚本），新依赖只能经
 * vendor 构建以全局变量形式进入：`window.__flowlinkDagre`。
 * index.html 在 app.js 之前引用该产物；缺失时 Process 面板显示明确错误
 * 而不是白屏（renderer/flow-graph.js 检测全局变量）。
 */
import * as dagre from '@dagrejs/dagre'

;(globalThis as { __flowlinkDagre?: unknown }).__flowlinkDagre = dagre
