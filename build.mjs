/**
 * 打包脚本：构建主进程（ESM）和 preload（CJS）。
 *
 * 引擎代码已拷贝到 ./engine/，通过相对路径 import，esbuild 直接打包。
 * 无 alias、无外部引用 —— 项目完全独立。
 *
 * 主进程 src/main.ts → dist/main.js
 *   - ESM 格式：import.meta.url 原生可用；
 *   - 打包后 import.meta.url 指向 dist/main.js，recorder 的 capture-client.ts
 *     用 `../engine/recorder/capture/capture.js` 定位采集脚本；
 *   - playwright-core external：运行态只需 connectOverCDP，页面由 Electron 内嵌 Chromium 提供。
 *
 * Preload src/preload.ts → dist/preload.cjs
 *   - CJS 格式：只用到 electron 的 contextBridge/ipcRenderer。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/* ---------- 主进程（ESM）---------- */
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

/* ---------- Preload（CJS）---------- */
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
