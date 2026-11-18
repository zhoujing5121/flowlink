/**
 * rrweb 录制注入脚本 —— 构建产物 dist/rrweb-inject.js（browser IIFE）。
 *
 * 主进程（src/rrweb-capture.ts）从磁盘读取本产物内容，经 CDP
 * Page.addScriptToEvaluateOnNewDocument（新文档自动重启录制器）+
 * Runtime.evaluate 语义的 page.evaluate（当前文档立即生效）注入每个标签页。
 *
 * 约定：
 * - 主进程先 exposeBinding('__flowlinkRrwebEvent')，再注入本脚本；
 * - boot 由主进程携带 tabId 调用，事件经 window.__flowlinkRrwebEvent(tabId, event)
 *   回传 Node 侧（tabId 随事件携带，不依赖绑定回调的 source 对象身份）。
 */
import { record } from 'rrweb'

interface FlowlinkRrwebWindow {
	top: unknown
	self: unknown
	__flowlinkRrwebEvent?: (tabId: string, event: unknown) => void
	__flowlinkRrwebBoot?: (tabId: string) => boolean
	__flowlinkRrwebStop?: () => void
}

const w = globalThis as unknown as FlowlinkRrwebWindow

w.__flowlinkRrwebBoot = function (tabId: string): boolean {
	// iframe 内不重复录（主文档的快照与变更观察已覆盖）；已在录或事件通道
	// 未就绪时跳过，返回值供主进程确认注入是否真正生效。
	if (w.top !== w.self) return false
	if (typeof w.__flowlinkRrwebStop === 'function') return true
	if (typeof tabId !== 'string' || !tabId) return false
	if (typeof w.__flowlinkRrwebEvent !== 'function') return false
	const stop = record({
		emit: (event) => {
			try {
				w.__flowlinkRrwebEvent?.(tabId, event)
			} catch {
				/* 页面正在销毁：事件丢弃即可 */
			}
		},
		// 安全硬要求：password 输入值一律掩码，与产品 secret 策略一致。
		maskInputOptions: { password: true },
		recordCanvas: false,
	})
	w.__flowlinkRrwebStop = function (): void {
		delete w.__flowlinkRrwebStop
		try {
			stop?.()
		} catch {
			/* 观察器已随文档销毁 */
		}
	}
	return true
}
