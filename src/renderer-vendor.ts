/**
 * 渲染层第三方依赖的 vendor 入口（构建产物 dist/renderer-vendor.js）。
 *
 * 渲染层没有打包器（renderer/ 下是原样加载的普通脚本），新依赖只能经
 * vendor 构建以全局变量形式进入：`window.__flowlinkDagre`、
 * `window.__flowlinkRrweb`（Record 标签页的回放器）。
 * index.html 在 app.js 之前引用该产物；缺失时对应面板显示明确错误
 * 而不是白屏（renderer/flow-graph.js 与 app.js 的回放器都会检测全局变量）。
 */
// rrweb Replayer 的基础样式（鼠标/轨迹定位等）必须与 vendor bundle 同源：
// 从本入口 import 后，vendor 构建会同步产出 dist/renderer-vendor.css
// （index.html <link> 引用）。缺失该样式时 mouse-tail canvas 会按文档流
// 静态排版，把回放 iframe 挤出舞台可视区 → 回放黑屏（2026-11-17 实锤）。
import 'rrweb/dist/style.css'
import * as dagre from '@dagrejs/dagre'
import { Replayer } from 'rrweb'

type FlowlinkVendorGlobal = {
	__flowlinkDagre?: unknown
	__flowlinkRrweb?: { Replayer: typeof Replayer }
}

;(globalThis as unknown as FlowlinkVendorGlobal).__flowlinkDagre = dagre
;(globalThis as unknown as FlowlinkVendorGlobal).__flowlinkRrweb = { Replayer }
