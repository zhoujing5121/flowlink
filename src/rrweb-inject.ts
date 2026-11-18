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
 *   回传 Node 侧（tabId 随事件携带，不依赖绑定回调的 source 对象身份）；
 * - 新文档里 init script 可能先于 Playwright 的绑定注入执行（顺序竞态，
 *   跨导航丢事件的根因之一）：boot 发现 binding 未就绪时页内自旋等待
 *   （BINDING_POLL_MS × BINDING_POLL_TIMES ≈ 5s），就绪即真正启动。
 */
import { record } from 'rrweb'

interface FlowlinkRrwebWindow {
	top: unknown
	self: unknown
	__flowlinkRrwebEvent?: (tabId: string, event: unknown) => void
	__flowlinkRrwebBoot?: (tabId: string) => boolean
	__flowlinkRrwebStop?: () => void
	/** binding 自旋等待进行中（防止并发 boot 重复起录/重复自旋） */
	__flowlinkRrwebBootPending?: boolean
}

/** binding 自旋：200ms × 25 ≈ 5s，覆盖 Playwright 绑定注入最坏滞后。 */
const BINDING_POLL_MS = 200
const BINDING_POLL_TIMES = 25

const w = globalThis as unknown as FlowlinkRrwebWindow

function startRecording(tabId: string): void {
	// 幂等：init script 与主进程 evaluate 可能各触发一次启动路径。
	if (typeof w.__flowlinkRrwebStop === 'function') return
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
		// 快照瘦身（重企业页面导航期 full snapshot 的 CPU 尖峰是录制闪烁的
		// 剩余嫌疑之一）：保守组合——只去掉回放时不可见的节点，DOM 结构
		// 与可见内容完全不变（script 保留，避免影响选择器语义）。
		slimDOMOptions: {
			script: false,
			comment: true,
			headFavicon: true,
			headWhitespace: true,
			headMetaDescKeywords: true,
			headMetaRobots: true,
			headMetaHttpEquiv: true,
			headMetaAuthorship: true,
			headMetaVerification: true,
			headMetaSocial: true,
			headTitleMutations: true,
		},
	})
	w.__flowlinkRrwebStop = function (): void {
		delete w.__flowlinkRrwebStop
		try {
			stop?.()
		} catch {
			/* 观察器已随文档销毁 */
		}
	}
}

w.__flowlinkRrwebBoot = function (tabId: string): boolean {
	// iframe 内不重复录（主文档的快照与变更观察已覆盖）。
	if (w.top !== w.self) return false
	if (typeof tabId !== 'string' || !tabId) return false
	// 已在录（幂等）。
	if (typeof w.__flowlinkRrwebStop === 'function') return true
	if (typeof w.__flowlinkRrwebEvent === 'function') {
		startRecording(tabId)
		return true
	}
	// binding 未就绪：自旋等待，就绪即启动。期间再被调用（主进程 evaluate
	// 重试、init script 重复执行）不另起一份自旋；返回 true 表示「本 tab 的
	// 启动已被受理」，真正起录由自旋完成（主进程以 __flowlinkRrwebStop 确认）。
	if (w.__flowlinkRrwebBootPending) return true
	w.__flowlinkRrwebBootPending = true
	let remaining = BINDING_POLL_TIMES
	const timer = setInterval(() => {
		if (typeof w.__flowlinkRrwebStop === 'function') {
			// 自旋期间其它路径已起录：直接收尾。
			clearInterval(timer)
			delete w.__flowlinkRrwebBootPending
			return
		}
		if (typeof w.__flowlinkRrwebEvent === 'function') {
			clearInterval(timer)
			delete w.__flowlinkRrwebBootPending
			startRecording(tabId)
			return
		}
		if (--remaining <= 0) {
			// 等满仍未就绪：放弃本次（清 pending，让后续 boot 调用——如主进程
			// 导航后的重 evaluate——可以重新尝试）。
			clearInterval(timer)
			delete w.__flowlinkRrwebBootPending
		}
	}, BINDING_POLL_MS)
	return true
}
