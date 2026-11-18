/**
 * 打包脚本：分别构建主进程（ESM）和 preload（CJS）。
 *
 * 引擎代码位于 ./engine/，通过相对路径导入并由 esbuild 一并打包。
 * 不依赖路径别名；除运行时依赖外，不引用工程外部源码。
 *
 * 主进程 src/main.ts → dist/main.js
 *   - 使用 ESM 格式，以便原生使用 import.meta.url；
 *   - 打包后 import.meta.url 指向 dist/main.js，recorder 的 capture-client.ts
 *     据此通过 `../engine/recorder/capture/capture.js` 定位采集脚本；
 *   - playwright-core 保留为外部依赖：运行时只用 connectOverCDP，页面由 Electron 内嵌 Chromium 提供。
 *
 * Preload 源文件 src/preload.ts → 构建产物 dist/preload.cjs
 *   - 使用 CJS 格式；仅调用 electron 的 contextBridge 与 ipcRenderer。
 */
import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/* ---------- 主进程（ESM）构建 ---------- */
await build({
	entryPoints: [here + 'src/main.ts'],
	outfile: here + 'dist/main.js',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	logLevel: 'info',
	external: ['electron', 'playwright-core', 'zod', 'undici', '@earendil-works/pi-coding-agent', '@browser_use/pi', '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/index.js', '../node_modules/@browser_use/pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js'],
	mainFields: ['module', 'main'],
	conditions: ['node', 'import'],
	banner: {
		js: 'import { createRequire as __createRequire } from "module";\nconst require = __createRequire(import.meta.url);',
	},
})

/* Pi SDK worker: keep SDK initialization and provider calls off Electron's main thread. */
await build({
	entryPoints: [here + 'src/pi-agent-worker.ts'],
	outfile: here + 'dist/pi-agent-worker.js',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: true,
	logLevel: 'info',
	external: ['undici', '@earendil-works/pi-coding-agent'],
	mainFields: ['module', 'main'],
	conditions: ['node', 'import'],
})

/* ---------- Preload（CJS）构建 ---------- */
await build({
	entryPoints: [here + 'src/preload.ts'],
	outfile: here + 'dist/preload.cjs',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: true,
	logLevel: 'info',
	external: ['electron'],
})

/* ---------- Renderer vendor（IIFE 浏览器全局）构建 ----------
 *
 * 渲染层无打包器（renderer/index.html 原样加载 app.js/bridge.js/flow-graph.js），
 * 新依赖（如 dagre、rrweb Replayer）只能经此入口以全局变量进入：
 * `window.__flowlinkDagre`、`window.__flowlinkRrweb`。
 * target 与 Electron 45 的 Chromium 匹配（es2022）。
 */
await build({
	entryPoints: [here + 'src/renderer-vendor.ts'],
	outfile: here + 'dist/renderer-vendor.js',
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	sourcemap: true,
	logLevel: 'info',
})

/* ---------- rrweb 注入 bundle（browser IIFE，主进程从磁盘读取后注入页面） ----------
 *
 * 仅含 rrweb record 与 boot 入口（src/rrweb-inject.ts），无外部依赖。
 * src/rrweb-capture.ts 按 dist/main.js 的相对路径读取该产物并注入各标签页
 * （先例：engine 的 capture.js 静态资源随包分发）。
 */
await build({
	entryPoints: [here + 'src/rrweb-inject.ts'],
	outfile: here + 'dist/rrweb-inject.js',
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2022',
	sourcemap: true,
	logLevel: 'info',
})

/* rrweb Replayer 的回放样式（鼠标轨迹等）：原样随包复制，index.html <link> 引用。 */
await copyFile(
	here + 'node_modules/rrweb/dist/style.css',
	here + 'dist/rrweb-replay.css',
)
