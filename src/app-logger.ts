/**
 * 应用公共日志：单行通用格式（ISO 时间 + 级别 + 模块 + 消息）写入本地文件，
 * 供主进程、worker 线程与各子系统（Pi、perf 计时、录制/回放等）共用。
 *
 * 落盘目录由 FLOWLINK_LOG_DIR 指定（主进程在启动时设置为
 * userData/flowlink/logs，worker 线程创建时继承该环境变量）；
 * 未设置时仅镜像到控制台，不写文件（如单测）。
 * 文件超过 5MB 时轮转为 .old（保留一代）。逐行 appendFileSync，跨线程单行写入安全。
 * 级别经 FLOWLINK_LOG_LEVEL（debug|info|warn|error，默认 info）过滤；
 * FLOWLINK_LOG_MIRROR=all 时 INFO 也镜像到控制台（默认仅 WARN+ 镜像）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_LOG_BYTES = 5 * 1024 * 1024

let rotationChecked = false

function activeLevel(): LogLevel {
	const raw = process.env.FLOWLINK_LOG_LEVEL
	return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

function logFile(): string | undefined {
	const dir = process.env.FLOWLINK_LOG_DIR
	if (!dir) return undefined
	const file = join(dir, 'flowlink.log')
	if (!rotationChecked) {
		rotationChecked = true
		try {
			if (statSync(file).size > MAX_LOG_BYTES) {
				try {
					renameSync(file, `${file}.old`)
				} catch {
					// .old 被占用等情况下放弃轮转，继续追加。
				}
			}
		} catch {
			// 文件不存在：首次写入时创建。
		}
		try {
			mkdirSync(dir, { recursive: true })
		} catch {
			return undefined
		}
	}
	return file
}

export function appLog(level: LogLevel, module: string, message: string): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return
	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${module}] ${message.replace(/\s+/g, ' ').trim()}`
	const file = logFile()
	if (file) {
		try {
			appendFileSync(file, `${line}\n`)
		} catch {
			// 写失败（占用/磁盘）时退化为仅控制台。
		}
	}
	if (LEVEL_ORDER[level] >= LEVEL_ORDER[warnLevel()] ) {
		console.log(`[app-log] ${line}`)
	}
}

function warnLevel(): LogLevel {
	return process.env.FLOWLINK_LOG_MIRROR === 'all' ? 'info' : 'warn'
}

/** 把键值对拼成 `key=value` 片段（值中的空白已折叠）。 */
export function appLogFields(fields: Record<string, string | number | boolean | undefined>): string {
	return Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value).replace(/\s+/g, ' ')}`)
		.join(' ')
}
