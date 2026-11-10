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
	external: ['electron', 'playwright-core', 'zod'],
	mainFields: ['module', 'main'],
	conditions: ['node', 'import'],
	banner: {
		js: 'import { createRequire as __createRequire } from "module";\nconst require = __createRequire(import.meta.url);',
	},
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
