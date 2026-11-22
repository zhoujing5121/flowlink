/**
 * W1 计时辅助：在关键路径边界打印一行 `[perf]` 日志（Date.now() 精度即可），
 * 作为冷启动、Record 首跳与 Pi 首条消息的前后对比证据。常开、每边界一行。
 * 同时写入应用公共日志（FLOWLINK_LOG_DIR 设置后落 flowlink.log，与业务日志同文件）。
 */
import { appLog } from './app-logger.js'

const appStart = Date.now()

export function perf(label: string) {
	const startedAt = Date.now()
	return {
		mark(name: string): void {
			const elapsed = Date.now() - startedAt
			console.log(`[perf] ${label}:${name} +${elapsed}ms`)
			appLog('info', 'perf', `${label}:${name} +${elapsed}ms`)
		},
	}
}

/** 距本进程模块加载起点的总耗时，用于冷启动观察。 */
export function perfSinceAppStart(name: string): void {
	const elapsed = Date.now() - appStart
	console.log(`[perf] ${name} t+${elapsed}ms`)
	appLog('info', 'perf', `${name} t+${elapsed}ms`)
}
