/**
 * 渲染层第三方依赖的 vendor 入口（构建产物 dist/renderer-vendor.js）。
 *
 * 渲染层没有打包器（renderer/ 下是原样加载的普通脚本），新依赖只能经
 * vendor 构建以全局变量形式进入：`window.__flowlinkDagre`、
 * `window.__flowlinkRrweb`（Record 标签页的回放器）、`window.__flowlinkX6`
 * （Process 画布引擎；X6 3.x 已把 MiniMap 等插件并入核心包，
 * Graph.registerNode/registerConnector 等静态都在该全局上）。
 * index.html 在 app.js 之前引用该产物；缺失时对应面板显示明确错误
 * 而不是白屏（renderer/flow-graph.js 与 app.js 的回放器都会检测全局变量）。
 * 注意：X6 3.x 的 package.json 是 "type": "module" 且 lib/ CJS 与 Node 的
 * require 互操作有坑，但这里只经 esbuild（module 字段 → es/ 真 ESM）
 * 打成浏览器 IIFE，运行时无 Node require，不受影响。
 */
// rrweb Replayer 的基础样式（鼠标/轨迹定位等）必须与 vendor bundle 同源：
// 从本入口 import 后，vendor 构建会同步产出 dist/renderer-vendor.css
// （index.html <link> 引用）。缺失该样式时 mouse-tail canvas 会按文档流
// 静态排版，把回放 iframe 挤出舞台可视区 → 回放黑屏（2026-11-17 实锤）。
// X6 核心与其插件样式（含 MiniMap）由库在运行时自动注入文档
// （Config.autoInsertCSS + CssLoader.ensure），无需在此引入 CSS。
import 'rrweb/dist/style.css'
import * as dagre from '@dagrejs/dagre'
import * as X6 from '@antv/x6'
import { Replayer } from 'rrweb'

type FlowlinkVendorGlobal = {
	__flowlinkDagre?: unknown
	__flowlinkRrweb?: { Replayer: typeof Replayer }
	__flowlinkX6?: Record<string, unknown>
}

;(globalThis as unknown as FlowlinkVendorGlobal).__flowlinkDagre = dagre
;(globalThis as unknown as FlowlinkVendorGlobal).__flowlinkRrweb = { Replayer }
;(globalThis as unknown as FlowlinkVendorGlobal).__flowlinkX6 = {
	...X6,
}
