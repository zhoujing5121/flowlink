#!/usr/bin/env node
/**
 * FlowLink 启动器（纯 Node 版本，npm scripts 与 agent/任意 shell 通用）。
 *
 * 先执行构建，再启动 Electron 并透传子进程退出码；Windows 下同时把当前
 * 控制台代码页切换为 UTF-8（原 start.ps1 的 chcp 65001 行为，该脚本已移除），
 * 保证中文诊断日志在终端与重定向输出中不乱码。
 *
 * 用法：node scripts/start.mjs [--dev] [--pi-system-proxy] [--pi-proxy <url>]
 * 兼容旧 start.ps1 的参数拼写（-Dev / -PiSystemProxy / -PiProxy <url>）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const electronFlags = []
for (let i = 0; i < args.length; i++) {
	const arg = args[i]
	if (arg === '--dev' || arg === '-Dev') {
		electronFlags.push('--inspect=9229')
	} else if (arg === '--pi-system-proxy' || arg === '-PiSystemProxy') {
		electronFlags.push('--pi-system-proxy')
	} else if (arg === '--pi-proxy' || arg === '-PiProxy') {
		const url = args[++i]
		if (!url) {
			console.error('缺少 --pi-proxy 的代理 URL 参数')
			process.exit(2)
		}
		electronFlags.push(`--pi-proxy=${url}`)
	} else if (arg.startsWith('--pi-proxy=')) {
		electronFlags.push(arg)
	} else {
		console.error(`未知参数：${arg}（支持 --dev / --pi-system-proxy / --pi-proxy <url>）`)
		process.exit(2)
	}
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
process.chdir(projectRoot)

if (process.platform === 'win32') {
	// 与旧 start.ps1 的 chcp 65001 等价：把当前控制台代码页切到 UTF-8，
	// 保证重定向/管道输出中的中文日志按 UTF-8 解码（交互式终端 Node 本身
	// 走 WriteConsoleW，不受代码页影响）。无控制台宿主（mintty/CI）时失败即忽略。
	spawnSync('chcp.com', ['65001'], { stdio: 'ignore' })
}

const build = spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const electronCli = join('node_modules', 'electron', 'cli.js')
const electron = spawn(process.execPath, [electronCli, '.', ...electronFlags], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => electron.kill(signal))
}
electron.on('close', (code) => process.exit(code ?? 0))
electron.on('error', (err) => {
	console.error(`启动 Electron 失败：${err.message}`)
	process.exit(1)
})
