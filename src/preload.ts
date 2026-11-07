/**
 * Preload：在渲染进程的隔离世界里运行，通过 contextBridge 暴露 window.flowlink。
 *
 * 设计原则：
 * - 所有跨进程调用都走 ipcRenderer.invoke（返回 Promise），主进程用 ipcMain.handle 接。
 * - 流式事件（录制步骤 / 回放进度 / URL 变更）用 ipcRenderer.on 收，转发成回调。
 * - 渲染进程拿不到 Node / Electron 对象，只有 window.flowlink 这个受控 API。
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
	tasks: {
		list: () => ipcRenderer.invoke('tasks:list'),
		saveProfile: (patch: unknown) => ipcRenderer.invoke('tasks:saveProfile', patch),
		remove: (code: string) => ipcRenderer.invoke('tasks:delete', code),
		getRecordings: (code: string) => ipcRenderer.invoke('tasks:getRecordings', code),
		removeRecording: (code: string, recordingId: string) =>
			ipcRenderer.invoke('tasks:removeRecording', code, recordingId),
	},

	recording: {
		/** 启动录制：主进程附着 CDP + recordOnPage，后台运行，步骤通过 on('recording:step') 推送 */
		start: (opts: { taskCode: string; startUrl: string }) =>
			ipcRenderer.invoke('recording:start', opts),
		/** 停止录制：abort stopSignal → 等 recordOnPage resolve → 返回 RecordingMeta */
		stop: () => ipcRenderer.invoke('recording:stop'),
		/** 导航内嵌浏览器 */
		navigate: (url: string, tabId?: string) => ipcRenderer.invoke('recording:navigate', url, tabId),
		goBack: (tabId?: string) => ipcRenderer.invoke('recording:goBack', tabId),
		goForward: (tabId?: string) => ipcRenderer.invoke('recording:goForward', tabId),
		reload: (tabId?: string) => ipcRenderer.invoke('recording:reload', tabId),
		/** 获取内嵌浏览器当前 URL */
		currentUrl: () => ipcRenderer.invoke('recording:currentUrl'),
		saveVideo: (opts: { recordingId: string; taskCode: string; dataUrl: string }) =>
			ipcRenderer.invoke('recording:saveVideo', opts),
	},

	playback: {
		run: (opts: { taskCode: string; recordingId: string }) =>
			ipcRenderer.invoke('playback:run', opts),
	},

	flow: {
		load: (flowFile: string) => ipcRenderer.invoke('flow:load', flowFile),
	},

	browser: {
		/** 告诉主进程内嵌浏览器该显示在哪（相对窗口内容区的矩形） */
		setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
			ipcRenderer.invoke('browser:setBounds', rect),
		hide: () => ipcRenderer.invoke('browser:hide'),
		restart: (initialUrl: string) => ipcRenderer.invoke('browser:restart', initialUrl),
		createTab: () => ipcRenderer.invoke('browser:createTab'),
		switchTab: (tabId: string) => ipcRenderer.invoke('browser:switchTab', tabId),
		closeTab: (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId),
	},

	/** 事件订阅：recording:step / recording:done / recording:error / playback:step / playback:done / playback:error / browser:urlChanged */
	on: (channel: string, handler: (...args: unknown[]) => void) => {
		const valid = [
			'recording:step',
			'recording:done',
			'recording:error',
			'browser:error',
			'playback:step',
			'playback:done',
			'playback:error',
			'browser:urlChanged',
			'browser:loading',
			'recording:captureFrame',
			'browser:tabOpened',
		]
		if (!valid.includes(channel)) return () => {}
		const listener = (_event: unknown, ...args: unknown[]) => handler(...args)
		ipcRenderer.on(channel, listener)
		return () => ipcRenderer.removeListener(channel, listener)
	},
}

contextBridge.exposeInMainWorld('flowlink', api)
