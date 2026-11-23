/**
 * Preload：在渲染进程的隔离世界里运行，通过 contextBridge 暴露 window.flowlink。
 *
 * 设计原则：
 * - 所有跨进程调用都走 ipcRenderer.invoke（返回 Promise），主进程用 ipcMain.handle 接。
 * - 流式事件（录制步骤 / 回放进度 / URL 变更）用 ipcRenderer.on 收，转发成回调。
 * - 渲染进程拿不到 Node / Electron 对象，只有 window.flowlink 这个受控 API。
 */
import { contextBridge, ipcRenderer } from 'electron'

/**
 * 此对象构成渲染进程可用能力的完整边界。invoke 方法返回主进程处理器的
 * Promise 结果；事件订阅会隐藏 Electron event 对象，并返回取消订阅函数，
 * 使界面组件能在销毁或切换时清理监听器。
 */
const api = {
	tasks: {
		list: () => ipcRenderer.invoke('tasks:list'),
		saveProfile: (patch: unknown) => ipcRenderer.invoke('tasks:saveProfile', patch),
		remove: (code: string) => ipcRenderer.invoke('tasks:delete', code),
		getRecordings: (code: string) => ipcRenderer.invoke('tasks:getRecordings', code),
		removeRecording: (code: string, recordingId: string) =>
			ipcRenderer.invoke('tasks:removeRecording', code, recordingId),
	},

	processLandscape: {
		load: () => ipcRenderer.invoke('processLandscape:load'),
	},

	recording: {
		/** 启动录制：主进程附着 CDP + recordOnPage，后台运行，步骤通过 on('recording:step') 推送 */
		start: (opts: { taskCode: string; startUrl: string; preservePage?: boolean }) =>
			ipcRenderer.invoke('recording:start', opts),
		/** 停止录制；discard=true 时后台清理，调用方无需等待空录制收尾 */
		stop: (opts?: { discard?: boolean }) => ipcRenderer.invoke('recording:stop', opts),
		/** 导航内嵌浏览器 */
		navigate: (url: string, tabId?: string) => ipcRenderer.invoke('recording:navigate', url, tabId),
		goBack: (tabId?: string) => ipcRenderer.invoke('recording:goBack', tabId),
		goForward: (tabId?: string) => ipcRenderer.invoke('recording:goForward', tabId),
		reload: (tabId?: string) => ipcRenderer.invoke('recording:reload', tabId),
		/** 获取内嵌浏览器当前 URL */
		currentUrl: () => ipcRenderer.invoke('recording:currentUrl'),
		/** 读取一段 rrweb 录制（manifest + 各标签页事件流），Record 标签页回放用 */
		loadRrweb: (dir: string) => ipcRenderer.invoke('recording:loadRrweb', dir),
		/** 只读 artifacts：返回录制 artifacts 根与 stepId → crop 截图 file:// URL（路径校验在主进程） */
		artifactsPath: (opts: { taskCode: string; recordingId: string }) =>
			ipcRenderer.invoke('recording:artifactsPath', opts),
		persistMerged: (opts: { taskCode: string; flow: unknown; name: string }) =>
			ipcRenderer.invoke('recording:persistMerged', opts),
	},

	playback: {
		run: (opts: { taskCode: string; recordingId: string; variables?: Record<string, string> }) =>
			ipcRenderer.invoke('playback:run', opts),
		continueUserOperation: (token: string) =>
			ipcRenderer.invoke('playback:continueUserOperation', token),
		/** 仅回放已有录制的前 N 步，为节点重录准备浏览器状态 */
		runPrefix: (opts: { taskCode: string; recordingId: string; stepCount: number }) =>
			ipcRenderer.invoke('playback:runPrefix', opts),
		/** AI 接管续跑：Test 失败后让 browser-use agent 在内嵌浏览器上完成剩余步骤（进度走 playback:aiStep/aiDone 事件） */
		aiContinue: (opts: {
			taskCode: string
			recordingId: string
			fromStepIndex: number
			variables?: Record<string, string>
			failureSummary?: string
		}) => ipcRenderer.invoke('playback:aiContinue', opts),
		/** 中止当前正在运行的回放/测试 */
		stop: () => ipcRenderer.invoke('playback:stop'),
	},

	pi: {
		status: () => ipcRenderer.invoke('pi:status'),
		/** 空闲预热 Pi worker（SDK 导入 + 运行时缓存），不发起 provider 请求 */
		prewarm: () => ipcRenderer.invoke('pi:prewarm'),
		/** 停止当前进行中的 Pi 请求：挂起请求全部以 cancelled 拒绝，worker 下次请求时重建 */
		stop: () => ipcRenderer.invoke('pi:stop'),
		prompt: (opts: { prompt: string; timeoutMs?: number }) => ipcRenderer.invoke('pi:prompt', opts),
		/** AI 面板聊天诊断日志：结构化事件写入应用日志（ai-chat 模块），不回传数据 */
		logChat: (payload: { kind: string; [key: string]: unknown }) => ipcRenderer.invoke('ai:logChat', payload),
		/** 提示词模板（config/prompts.json），渲染层 AI 面板组装建议请求用 */
		promptTemplates: () => ipcRenderer.invoke('pi:promptTemplates'),
		/** 从已保存录制生成细化的新 Flow：主进程负责投影、提示词、校验；返回已校验的提案（不落盘） */
		generateFlow: (opts: {
			taskCode: string
			recordingIds: string[]
			instruction?: string
			conversation?: Array<{ role: string; text: string }>
		}) => ipcRenderer.invoke('pi:generateFlow', opts),
		/** AI 接管后的自动流程修复：带失败与接管证据重跑细化，返回修复后的完整 Flow 与步骤提案（不落盘） */
		repairFlow: (opts: {
			taskCode: string
			recordingId: string
			takeover?: {
				ok?: boolean
				summary?: string
				aiCompleted?: number
				failedSteps?: Array<{ stepId: string; label?: string; error?: string }>
				aiSteps?: string[]
				artifactDir?: string
			}
		}) => ipcRenderer.invoke('pi:repairFlow', opts),
	},

	flow: {
		load: (flowFile: string) => ipcRenderer.invoke('flow:load', flowFile),
		/** 变量元数据落盘（version+1，.bak）；attachments 与元数据同一次原子保存（附件字节写入 references/） */
		updateVariables: (opts: {
			taskCode: string
			recordingId: string
			variables: unknown[]
			attachments?: Array<{ name: string; fileName: string; data: Uint8Array }>
		}) => ipcRenderer.invoke('flow:updateVariables', opts),
		updateSteps: (opts: { taskCode: string; recordingId: string; steps: unknown[] }) =>
			ipcRenderer.invoke('flow:updateSteps', opts),
		/** REFINED 单线演进：AI 对已 REFINED 记录的修改暂存为 pending（不落正式盘），AI 面板 Confirm/Discard 决议 */
		stagePending: (opts: {
			taskCode: string
			recordingId: string
			source: 'refine' | 'takeover-repair'
			flow: unknown
			summary?: string
			risks?: string[]
		}) => ipcRenderer.invoke('flow:stagePending', opts),
		/** 读取未决议 pending（无则 null）：{version, createdAt, source, flow, summary, risks, baseVersion} */
		loadPending: (opts: { taskCode: string; recordingId: string }) =>
			ipcRenderer.invoke('flow:loadPending', opts),
		/** 确认 pending：存历史快照 → 校验 baseVersion → 覆盖正式 Flow（version+1，.bak 保留）→ 清 pending；返回新 flow */
		confirmPending: (opts: { taskCode: string; recordingId: string }) =>
			ipcRenderer.invoke('flow:confirmPending', opts),
		/** 丢弃 pending：删 pending 文件与 pendingUpdate 标记 */
		discardPending: (opts: { taskCode: string; recordingId: string }) =>
			ipcRenderer.invoke('flow:discardPending', opts),
		/** 接管修复直落盘：历史快照 → version+1 覆盖正式 Flow（不产生 pending）；返回新 flow */
		directUpdate: (opts: { taskCode: string; recordingId: string; flow: unknown; summary?: string }) =>
			ipcRenderer.invoke('flow:directUpdate', opts),
	},

	/** Reference 一等对象：类型目录 / 即时校验 / 上传文件持久化（窄 API，无 Node 泄漏） */
	reference: {
		/** 类型目录 + 终端显示映射 + 上传扩展名（唯一来源，渲染层不复制） */
		catalog: () => ipcRenderer.invoke('reference:catalog'),
		/** 单对象静态校验（编辑对话框即时反馈，不落盘）：{ ok, issues } */
		validateObject: (opts: { objects: unknown[]; name: string }) =>
			ipcRenderer.invoke('reference:validateObject', opts),
		/** 全量校验（回放前干跑）：{ ok, issues, values, injectedEmpty } */
		validateAll: (opts: { objects: unknown[]; values?: Record<string, string> }) =>
			ipcRenderer.invoke('reference:validateAll', opts),
		/** 规则摘要 + 预设反编译（表格列与对话框默认视图共用）：机器键 → { summary, custom, presets } */
		describe: (opts: { objects: unknown[] }) =>
			ipcRenderer.invoke('reference:describe', opts),
		/** 上传文件持久化进工件目录（字节由渲染层读入）；返回 { id, name, type, path } */
		addFile: (opts: { taskCode: string; recordingId: string; name: string; data: Uint8Array }) =>
			ipcRenderer.invoke('flow:addReferenceFile', opts),
		/** 删除持久化文件（工件文件 + 元数据 + 版本递增） */
		removeFile: (opts: { taskCode: string; recordingId: string; fileId: string }) =>
			ipcRenderer.invoke('flow:removeReferenceFile', opts),
		/** 持久化文件的下载 URL（路径校验在主进程） */
		fileUrl: (opts: { taskCode: string; recordingId: string; fileId: string }) =>
			ipcRenderer.invoke('reference:fileUrl', opts),
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
			'playback:userOperation',
			'playback:aiStep',
			'playback:aiDone',
			'browser:urlChanged',
			'browser:loading',
			'browser:tabOpened',
			'ai:pending',
		]
		// 事件通道名称本身就是能力边界：即使通道名由渲染进程传入，也只能
		// 订阅下方明确允许的事件，不能监听任意 IPC 消息。
		if (!valid.includes(channel)) return () => {}
		const listener = (_event: unknown, ...args: unknown[]) => handler(...args)
		ipcRenderer.on(channel, listener)
		return () => ipcRenderer.removeListener(channel, listener)
	},
}

contextBridge.exposeInMainWorld('flowlink', api)
