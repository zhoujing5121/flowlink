import { existsSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// 将 electron-packager 输出的应用目录打包为可分发的 Windows ZIP。
// 创建压缩包前先验证可执行文件和媒体 DLL，避免不完整的包被误报成功。
const here = fileURLToPath(new URL('.', import.meta.url))
const appDir = join(here, 'release', 'FlowLink-win32-x64')
const exePath = join(appDir, 'FlowLink.exe')
const ffmpegPath = join(appDir, 'ffmpeg.dll')
const zipPath = join(here, 'release', 'FlowLink-Windows-x64.zip')

if (!existsSync(exePath)) {
	throw new Error(`Packaged executable not found: ${exePath}`)
}
if (!existsSync(ffmpegPath)) {
	throw new Error(`Electron ffmpeg.dll is missing from the package: ${ffmpegPath}`)
}

rmSync(zipPath, { force: true })
const result = spawnSync('tar.exe', [
	'-a',
	'-c',
	'-f',
	zipPath,
	'-C',
	join(here, 'release'),
	'FlowLink-win32-x64',
], {
	cwd: here,
	encoding: 'utf8',
})

if (result.status !== 0) {
	process.stderr.write(result.stderr || result.stdout || 'Failed to create the package archive.')
	process.exit(result.status || 1)
}

if (!existsSync(zipPath)) {
	throw new Error(`Package archive was not created: ${zipPath}`)
}

const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`  ffmpeg.dll bundled`)
console.log(`  package: release\\FlowLink-Windows-x64.zip (${sizeMb} MB)`)
