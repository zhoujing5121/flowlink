/**
 * FlowLink IPC Bridge —— 注入到 FlowLink.html 末尾，把 mock 逻辑替换为真实引擎调用。
 *
 * 覆盖范围：
 *  1. 数据层：flowData / saveProfile → IPC TaskStore
 *  2. 浏览器：iframe mock → WebContentsView 定位上报 + IPC 导航
 *  3. 录制：postMessage mock → IPC recordOnPage（步骤流式推送）
 *  4. 分析：referenceOperation mock → 真实 Flow 步骤
 *  5. 列表 Run/Delete：启用并接线 IPC
 *
 * 此 IIFE 在 app.js 初始化模拟界面及闭包后运行。它有意替换部分顶层函数绑定，
 * 而不另建一套渲染器状态模型：flowData、recordingSessions 和抽屉现有的渲染流程
 * 仍是共同的数据来源。原生浏览器由主进程中的 WebContentsView 承载，因此其位置和
 * 生命周期通过 preload IPC 协调，而不是依赖 iframe DOM。
 */
;(function () {
	const F = window.flowlink
	if (!F) {
		console.error('[bridge] window.flowlink 不可用——preload 未加载？')
		return
	}

	void F.processLandscape.load()
		.then((tree) => {
			setProcessLandscape(tree)
			$('profileSave').disabled = false
		})
		.catch((err) => {
			console.error('[bridge] 加载 Process Landscape 失败：', err)
			setProcessLandscapeError(err.message)
		})

	/* ================================================================
	 * 1. 数据层：用 IPC 加载任务，替换 mock flowData
	 * ================================================================ */

	/** 空任务骨架（新建时用） */
	function emptyTask(code) {
		return {
			code,
			name: '',
			description: '',
			version: 'v1.0.0',
			status: 'Ready',
			category: '',
			enabled: false,
			versions: [{ name: 'v1.0.0', enabled: false }],
			serviceLines: ['', '', '', ''],
			recordings: [],
			recordingCount: 0,
		}
	}

	/** 从 IPC 加载任务列表并刷新渲染 */
	async function loadTasksFromStore() {
		// 启动阶段只读取任务列表元数据；录制 Flow 和步骤详情延迟到打开任务抽屉时加载。
		try {
			const tasks = await F.tasks.list()
			flowData.length = 0
			for (const t of tasks) {
				flowData.push({
					code: t.code,
					name: t.name || t.code,
					description: t.description || '',
					version: t.version || 'r1',
					status: t.status || 'Ready',
					category: t.category || '',
					enabled: !!t.enabled,
					versions: t.versions || [{ name: 'V1', enabled: false }],
					serviceLines: t.serviceLines || ['', '', '', ''],
					recordings: [],
					recordingCount: t.recordingCount || 0,
				})
			}
			render()
		} catch (err) {
			console.error('[bridge] 加载任务失败：', err)
		}
	}

	window.loadTaskDetails = async function (taskCode, opts = {}) {
		const state = recordingSession(taskCode)
		if (state.detailsLoaded && !opts.force) return
		state.detailsLoadPromise ||= (async () => {
			const recordings = await F.tasks.getRecordings(taskCode)
			const existing = new Map(state.items.map((item) => [item.recordingId, item]))
			state.items = recordings.map((recording) => existing.get(recording.id) || ({
				id: recording.id,
				name: recording.name || recording.id,
				analyzed: true,
				recorded: true,
				summary: !!recording.isMerged,
				resultTab: 'Process',
				url: '',
				route: 'suppliers',
				actions: [],
				checked: false,
				steps: [],
				stepDetails: [],
				flowFile: recording.flowFile,
				artifactsDir: recording.artifactsDir,
				recordingId: recording.id,
				media: {
					videoURL: recording.videoFile
						? `file:///${String(recording.videoFile).replace(/\\/g, '/')}`
						: '',
					rrwebDir: recording.rrwebDir || '',
					screenshots: (recording.stepScreenshots || recording.frames || []).map((filePath, index) => ({
						image: `file:///${String(filePath).replace(/\\/g, '/')}`,
						name: `Step-${String(index + 1).padStart(2, '0')}.png`,
					})),
					posterFile: recording.posterFile || '',
				},
			}))
			if (activeFlowKey === taskCode && $('drawer').open) {
				renderRecordingItems()
			}

			await Promise.all(state.items.map(async (item) => {
				if (!item.recordingId || !item.flowFile || item.testFlowSteps?.length) return
				try {
					const flow = await F.flow.load(item.flowFile)
					const initialFlat = FlowGraph.flattenFlowSteps(flow?.steps || [])
					item.testFlowSteps = initialFlat.steps
					item.testFlowIndexById = initialFlat.indexById
					item.steps = item.testFlowSteps.map((step) => {
						const kind = step.kind || 'action'
						const value = step.url || step.text || step.value || ''
						return value ? `${kind} · ${String(value).replace(/^(?:https?:\/\/)/, '')}` : kind
					})
					// 整页步骤截图已移除（录制闪烁优化）：只保留真实存在的截图，
					// 不再补空占位到步数；Record 页空截图墙直接隐藏。
					item.media.screenshots = item.media.screenshots.slice(0, item.steps.length)
					item.testResults = item.testFlowSteps.map(() => ({ status: 'pending' }))
				} catch (err) {
					console.error(`[bridge] 录制详情加载失败 (${item.recordingId}):`, err)
				}
			}))

			state.detailsLoaded = true
			if (activeFlowKey === taskCode && $('drawer').open && drawerView === 'Design') {
				renderRecordingWorkspace()
			}
		})().finally(() => {
			state.detailsLoadPromise = null
		})
		await state.detailsLoadPromise
	}

	/* ================================================================
	 * 2. saveProfile → IPC
	 * ================================================================ */
	let profileSaveInFlight = false
	saveProfile = async function () {
		// 串行处理保存，并在提交草稿前征求确认。
		// 只有 TaskStore 接受保存后，草稿才会成为 flowData 中的正式条目。
		if (profileSaveInFlight || !validateProfileServices()) return
		if (!(await confirmWorkspaceAction('Save this flow profile?'))) return
		// 先复制表单值和数组内容构成独立 patch；等待 IPC 时，输入草稿不会被服务端调用改写。
		const draft = profileDraft()
		const code = currentFlow?.code || nextTaskflowCode()
		// 每次保存推进一位版本号；首次保存归一为 v1.0.0。
		const version = currentFlow?.version ? nextTaskVersion(currentFlow.version) : 'v1.0.0'
		if (draft.versions.length) draft.versions[draft.versions.length - 1].name = version
		else draft.versions.push({ name: version, enabled: false })
		const patch = {
			code,
			name: $('flowName').value.trim(),
			description: $('flowDescription').value.trim(),
			serviceLines: [...draft.serviceLines],
			versions: draft.versions.map((v) => ({ ...v })),
			enabled: draft.versions.some((v) => v.enabled),
			version,
			category: currentFlow?.category || '',
			status: currentFlow?.status || 'Ready',
		}
		const button = $('profileSave')
		profileSaveInFlight = true
		button.disabled = true
		try {
			const task = await F.tasks.saveProfile(patch)
			// IPC 成功后才更新内存列表；新任务此时才取得正式编号并结束 "new" 草稿。
			if (currentFlow) {
				Object.assign(currentFlow, patch, {
					recordings: task.recordings || [],
					recordingCount: task.recordings?.length || 0,
				})
			} else {
				currentFlow = {
					...emptyTask(code),
					...patch,
					recordings: task.recordings || [],
					recordingCount: task.recordings?.length || 0,
				}
				flowData.push(currentFlow)
				profileDrafts.set(code, draft)
				profileDrafts.delete('new')
				activeFlowKey = code
			}
			$('drawerTitle').textContent = code
			draft.name = patch.name
			draft.description = patch.description
			render()
			$('profileSaveStatus').textContent = 'Saved.'
			await _origCloseDrawer()
		} catch (err) {
			// 保存失败时保留原草稿和抽屉，用户可修正后再次提交。
			console.error('[bridge] 保存 Profile 失败：', err)
			$('profileSaveStatus').textContent = 'Save failed: ' + err.message
		} finally {
			profileSaveInFlight = false
			button.disabled = false
		}
	}
	// index.html 在安装此 bridge 覆盖实现前，已经绑定了原始函数。
	$('profileSave').onclick = () => saveProfile()

	/* ================================================================
	 * 3. 浏览器：替换 iframe mock → WebContentsView 定位 + IPC 导航
	 * ================================================================ */

	/** validatedRecordingURL：只接受 http/https（拒绝 local:// mock URL） */
	validatedRecordingURL = function (value) {
		const input = String(value || '').trim()
		const usesLocalHttp = /^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(input)
		const candidate = /^https?:\/\//i.test(input)
			? input
			: `${usesLocalHttp ? 'http' : 'https'}://${input}`
		try {
			const parsed = new URL(candidate)
			if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname) return parsed.href
		} catch {}
		return null
	}

	/** 导航：更新页面状态 + 调 IPC 真实导航（不再加载 iframe） */
	navigateRecordingBrowser = async function (url, addHistory = true, page = activeBrowserPage()) {
		// 先乐观更新渲染器状态，让地址栏立即响应；若原生导航拒绝请求，
		// 则恢复之前的 URL，避免界面与浏览器实际页面不一致。
		const next = validatedRecordingURL(url)
		if (!next) return
		const state = recordingSession()
		if (!page.nativeId) page.nativeId = 'browser'
		const previousUrl = page.url
		page.url = next
		page.draftURL = next
		if (addHistory) {
			page.history = page.history.slice(0, page.historyIndex + 1)
			page.history.push(next)
			page.historyIndex = page.history.length - 1
		}
		if (state.stage === 'guide') state.stage = 'ready'
		syncBrowserSession()
		/* 真实导航：IPC → 主进程 → WebContentsView.loadURL */
		try {
			const actualUrl = await F.recording.navigate(next, page.nativeId)
			if (actualUrl) {
				page.url = actualUrl
				page.draftURL = actualUrl
				syncBrowserSession()
				updateBrowserChrome()
			}
		} catch (err) {
			page.url = previousUrl
			page.draftURL = previousUrl
			syncBrowserSession()
			updateBrowserChrome()
			const address = $('recordingAddress')
			if (address) {
				address.setCustomValidity(err?.message || 'Navigation failed')
				address.reportValidity()
			}
			throw err
		}
		if (state.view !== 'analysis') updateBrowserChrome()
	}

	/** loadRecordingFrame：no-op（真实浏览器由 WebContentsView 渲染） */
	loadRecordingFrame = function () {}

	/** moveRecordingHistory：IPC back/forward */
	moveRecordingHistory = function (direction) {
		const page = activeBrowserPage()
		const index = page.historyIndex + direction
		if (index < 0 || index >= page.history.length) return
		page.historyIndex = index
		if (!page.history[index]) {
			page.url = ''
			page.draftURL = ''
			syncBrowserSession()
			updateBrowserChrome()
		} else {
			navigateRecordingBrowser(page.history[index], false)
		}
	}

	/** mountBrowserSurface：不创建 iframe，改为上报 #browserFrames 矩形 */
	let boundsObserver = null
	let lastBrowserBoundsKey = ''
	mountBrowserSurface = function () {
		// 渲染器中的 browser frame 仅作为几何占位元素。
		// 实际的 WebContentsView 由主进程持续管理，并通过 reportBrowserBounds()
		// 定位到此元素上方。
		const state = recordingSession()
		if (state.browserTabs[0] && !state.browserTabs[0].nativeId)
			state.browserTabs[0].nativeId = 'browser'
		const layout = state.workspaceElement
		const browser = state.browserElement || createBrowserSurface(state)
		const testSlot = layout?.querySelector('.test-tab-browser-slot')
		const isTestMode = Boolean(layout?.classList.contains('is-test') && testSlot)
		const browserParent = isTestMode ? testSlot : layout
		if (browser.parentElement !== browserParent) {
			browserParent.appendChild(browser)
		}
		browser.hidden = false
		/* 不创建 iframe，也不在 mount 时清空容器——WebContentsView 由主进程复用。 */
		const frames = $('browserFrames')

		/* 绑定地址栏 + 导航按钮 */
		const address = $('recordingAddress')
		if (address) {
			address.oninput = (e) => {
				e.target.setCustomValidity('')
				activeBrowserPage().draftURL = e.target.value
			}
			address.onkeydown = (e) => {
				if (e.key === 'Enter') {
					e.preventDefault()
					openRecordingURL()
				}
			}
		}
		const back = $('recordingBack')
		const nativeTabId = () => activeBrowserPage()?.nativeId || 'browser'
		if (back) back.onclick = () => F.recording.goBack(nativeTabId())
		const fwd = $('recordingForward')
		if (fwd) fwd.onclick = () => F.recording.goForward(nativeTabId())
		const reload = $('recordingReload')
		if (reload) reload.onclick = () => F.recording.reload(nativeTabId())
		const plus = $('newBrowserPage')
		if (plus) plus.onclick = () => addBrowserPage()

		updateBrowserChrome()
		bindAIDock()
		if (typeof syncFloatingAIDock === 'function') {
			syncFloatingAIDock(isTestMode ? layout?.querySelector('.recording-results') : browser)
		}

		/* 上报 #browserFrames 矩形给主进程（WebContentsView 定位） */
		reportBrowserBounds()
		boundsObserver?.disconnect()
		boundsObserver = new ResizeObserver(reportBrowserBounds)
		if (frames) boundsObserver.observe(frames)
	}

	/**
	 * 隐藏原生浏览器视图。同时失效已上报的矩形缓存：reportBrowserBounds 有
	 * 「几何未变即跳过」的去重，若不在隐藏时清空 lastBrowserBoundsKey，
	 * 「隐藏 → 同尺寸恢复」场景永远不会重新上报，视图将停留在隐藏状态。
	 */
	function hideNativeBrowser() {
		lastBrowserBoundsKey = ''
		return F.browser.hide()
	}

	/** 把 #browserFrames 的屏幕矩形上报给主进程 */
	function reportBrowserBounds() {
		// Bounds 使用屏幕坐标，而非工作区局部坐标。忽略隐藏或尺寸为零的界面，
		// 并跳过未变化的矩形，避免布局观察器连续触发时发送冗余 IPC。
		const frames = $('browserFrames')
		if (!frames) {
			hideNativeBrowser()
			return
		}
		const rect = frames.getBoundingClientRect()
		if (rect.width < 2 || rect.height < 2) {
			hideNativeBrowser()
			return
		}
		const state = recordingSession()
		const dock = document.querySelector('.ai-dock')
		const reserveDock = dock && dock.isConnected && !state.workspaceElement?.classList.contains('is-test')
		const dockWidth = reserveDock ? Math.min(32, Math.max(0, rect.width - 2)) : 0
		const boundsWidth = Math.max(1, Math.round(rect.width - dockWidth))
		const boundsKey = `${Math.round(rect.x)},${Math.round(rect.y)},${boundsWidth},${Math.round(rect.height)}`
		if (boundsKey === lastBrowserBoundsKey) return
		// 先记下已上报的矩形，后续布局回调若尺寸未变即可直接跳过。
		lastBrowserBoundsKey = boundsKey
		F.browser.setBounds({
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: boundsWidth,
			height: Math.round(rect.height),
		})
	}

	// 原生 WebContentsView 会覆盖在渲染器对话框之上。每次显示工作区确认框前先隐藏它，
	// 随后强制更新 bounds，将原生视图恢复到正确位置。
	const showWorkspaceConfirmation = confirmWorkspaceAction
	confirmWorkspaceAction = async function (message) {
		// 原生内容会覆盖渲染器对话框；显示确认框前先隐藏原生视图，
		// 确认结束后重新测量位置并恢复覆盖层。
		await hideNativeBrowser().catch(() => undefined)
		try {
			return await showWorkspaceConfirmation(message)
		} finally {
			lastBrowserBoundsKey = ''
			reportBrowserBounds()
		}
	}

	/* ================================================================
	 * 4. 录制：IPC engine
	 * ================================================================ */

	/** startBrowserRecording：调 IPC recording:start */
	startBrowserRecording = async function (options = {}) {
		// 必须等浏览器导航完成后才能开始录制。分组录制在前缀回放抵达目标页面后，
		// 可通过 preservePage 保留当前页面，不再重复导航。
		const state = recordingSession()
		if (state.stage === 'recording') return
		const page = activeBrowserPage()
		const draftUrl = validatedRecordingURL(page.draftURL)
		if (!options.preservePage && draftUrl && draftUrl !== page.url) {
			try {
				await navigateRecordingBrowser(draftUrl)
			} catch {
				return
			}
		}
		syncBrowserSession()

		const startUrl = state.url || page.draftURL
		if (!validatedRecordingURL(startUrl)) {
			$('recordingAddress')?.focus()
			return
		}

		if (!state.pending?.reRecordTarget)
			state.pending = {
				url: state.url,
				route: state.route,
				actions: [],
				checked: false,
				analyzed: false,
				resultTab: 'Process',
				startedAt: Date.now(),
			}
		state.stage = 'recording'
		state.view = 'browser'
		ensureRecordingLayout()
		updateBrowserChrome()

		/* 启动真实录制 */
		const taskCode = currentFlow?.code || activeFlowKey
		try {
			const result = await F.recording.start({
				taskCode,
				startUrl,
				preservePage: options.preservePage === true,
			})
			// IPC 返回前 Stop 或取消可能已改变阶段；过期的启动结果不得覆盖新状态。
			if (result?.reason === 'cancelled' || state.stage !== 'recording') return
			console.log('[bridge] 录制已启动')
		} catch (err) {
			console.error('[bridge] 录制启动失败：', err)
			if (state.stage !== 'recording') return
			// 启动失败时撤销尚未完成的录制状态，并重绘可再次操作的工作区。
			state.pending = null
			state.stage = 'ready'
			renderRecordingWorkspace()
		}
	}

	const EMPTY_RECORDING_MESSAGE =
		'No steps have been recorded. A recording without steps will not be saved. Stop recording?'

	function exitEmptyRecording(state, pending) {
		// 明确丢弃没有步骤的捕获，不将其加入录制列表。
		// 普通录制和节点录制分别恢复到适当的浏览器/分析视图。
		const reRecordTarget = pending?.reRecordTarget
		delete pending.finishing
		if (state.pending === pending) state.pending = null
		state.stage = reRecordTarget ? 'done' : 'ready'
		state.view = reRecordTarget ? 'analysis' : 'browser'
		state.focused = reRecordTarget || null
		state.allExplicit = false
		if (reRecordTarget) {
			hideNativeBrowser()
			if (state.browserElement) state.browserElement.hidden = true
		}
		renderRecordingWorkspace()
		updateBrowserChrome()
	}

	/** finishBrowserRecording：调 IPC recording:stop，获取真实 flow */
	finishBrowserRecording = async function (options = {}) {
		// 同时停止引擎录制和渲染器媒体，但只有引擎返回 Flow 后才提交录制项。
		// 空捕获走独立的非阻塞路径，避免媒体停止失败时把界面卡在录制状态。
		const state = recordingSession()
		if (state.stage !== 'recording' || !state.pending || state.pending.finishing) return
		const pending = state.pending
		if (!options.skipEmptyConfirmation && !(pending.actions || []).length) {
			if (!(await confirmWorkspaceAction(EMPTY_RECORDING_MESSAGE))) return
			if (state.stage !== 'recording' || state.pending !== pending) return
		}
		pending.finishing = true
		updateBrowserChrome()
		const discardWithoutSteps = !(pending.actions || []).length
		const engineStop = F.recording.stop(discardWithoutSteps ? { discard: true } : undefined)
		engineStop.catch(() => undefined)
		if (discardWithoutSteps) {
			// 空录制的 Stop 刻意采用 fire-and-forget：浏览器收尾出错也不能
			// 让用户一直困在录制状态。
			exitEmptyRecording(state, pending)
			return
		}
		try {
			const result = await engineStop
			if (result?.reason === 'empty') {
				exitEmptyRecording(state, pending)
				return
			}
			if (!result?.recording) {
				// 引擎未返回录制的兜底路径：没有媒体可组装（旧媒体管线已删除）。
				const mediaResult = { videoURL: '', rrwebDir: '', screenshots: [] }
				const fallbackSteps = (pending.actions || []).map((action) => {
					if (action.type === 'click') return `点击【${action.target || '目标'}】`
					if (action.type === 'input') return `在【${action.target || '输入框'}】中填写：${action.value || ''}`
					if (action.type === 'navigate') return `打开 ${action.url || ''}`
					if (action.type === 'tab-open') return '打开新标签页'
					if (action.type === 'tab-switch') return '切换标签页'
					if (action.type === 'tab-close') return '关闭标签页'
					return action.type || '操作'
				}).filter(Boolean)
				if (!fallbackSteps.length) {
					exitEmptyRecording(state, pending)
					return
				}
				if (pending.groupId && state.items) {
					const target = state.items.find((entry) => entry.id === pending.reRecordTarget)
					if (target) {
						pending.recordedSteps = fallbackSteps
						pending.recordedDetails = fallbackSteps.map((text, index) => ({
							type: index === 0 ? 'open' : 'action',
							target: text,
							value: '',
							tab: 1,
							url: state.url || '',
						}))
						pending.recordedFlowSteps = []
						pending.media = mediaResult
						if (typeof finishGroupRecording === 'function') {
							await finishGroupRecording(state, pending, target)
							return
						}
					}
				}
				const number = ++recordingSequence
				const item = pending
				item.id = item.id || `recording-${Date.now().toString(36)}-${number}`
				item.name = item.name || generatedRecordingName()
				item.url = state.url
				item.route = state.route
				item.steps = fallbackSteps
				item.stepDetails = fallbackSteps.map((text, index) => ({
					type: index === 0 ? 'open' : 'action',
					target: text,
					value: '',
					tab: 1,
					url: state.url || '',
				}))
				item.processGroups = buildGroupsFromSteps([])
				item.analyzed = true
				item.recorded = true
				item.resultTab = 'Process'
				item.media = mediaResult
				const fallbackScreenshots = item.media.screenshots || []
				fallbackScreenshots.splice(item.steps.length)
				while (fallbackScreenshots.length < item.steps.length) {
					fallbackScreenshots.push({
						image: '',
						name: `Screenshot-${String(fallbackScreenshots.length + 1).padStart(2, '0')}.png`,
					})
				}
				fallbackScreenshots.forEach((s, i) => {
					s.name = `Screenshot-${String(i + 1).padStart(2, '0')}.png`
					if (!s.image) s.image = ''
				})
				state.items.push(item)
				state.focused = item.id
				state.pending = null
				state.stage = 'done'
				state.view = 'analysis'
				state.allExplicit = false
				hideNativeBrowser()
				renderRecordingWorkspace()
				if (typeof window.startFlowLinkAIAdvice === 'function') void window.startFlowLinkAIAdvice({ mode: 'recording-complete', items: [item], reason: 'The recording has stopped and only fallback steps were available. Review the captured material and advise what evidence is missing for reliable replay. Do not generate a replacement material yet.' })
				return
			}

			/* 加载 flow JSON 获取真实步骤 */
			let flowSteps = []
			let flow = null
			try {
				flow = await F.flow.load(result.recording.flowFile)
				flowSteps = flow.steps || []
			} catch (err) {
				console.error('[bridge] 加载 flow 失败：', err)
			}

			const number = ++recordingSequence
			const item = pending
			item.id = result.recording.id
			item.name = result.recording.name || generatedRecordingName()
			item.url = state.url
			item.route = state.route
			item.flowFile = result.recording.flowFile
			item.artifactsDir = result.recording.artifactsDir
			item.recordingId = result.recording.id
			const recordedScreenshots = (result.recording.stepScreenshots || result.recording.frames || [])
				.slice(0, flowSteps.length)
				.map((filePath, index) => ({
					image: `file:///${String(filePath).replace(/\\/g, '/')}`,
					name: `Step-${String(index + 1).padStart(2, '0')}.png`,
				}))
			// 整页步骤截图已随录制闪烁优化移除（rrweb 回放为主展示）：
			// 不再用空占位补齐到步数，无截图时 Record 页直接隐藏截图墙。
			item.media = {
				// 旧录制（webm 落盘）经 videoFile 回放；新录制走 rrwebDir 的 DOM 事件回放。
				videoURL: result.recording.videoFile
					? `file:///${String(result.recording.videoFile).replace(/\\/g, '/')}`
					: '',
				rrwebDir: result.recording.rrwebDir || '',
				screenshots: recordedScreenshots,
				posterFile: result.recording.posterFile || '',
			}
			// 行文本统一走 app.js 的 processStepLabel（优先 step.label，与
			// Instruction/Process 同源）；打开结果页时 hydrateProcessFlow →
			// syncProcessFlowPresentation 会再对齐，消除两套文本来源。
			// item.stepDetails 不再写入：该草稿仅供演示路径（ensureStepDetails 兜底）。
			item.steps = flowSteps.map((step, index) => (
				typeof processStepLabel === 'function' ? processStepLabel(step, index) : flowStepToText(step)
			))
			item.processGroups = buildGroupsFromSteps(flowSteps)
			item.analyzed = true
			item.recorded = true
			delete item.finishing

			if (pending.groupId && state.items) {
				const target = state.items.find((entry) => entry.id === pending.reRecordTarget)
				if (target) {
					pending.recordedSteps = flowSteps.map(flowStepToText)
					pending.recordedDetails = flowSteps.map(flowStepToDetail)
					pending.recordedFlowSteps = flowSteps
					if (typeof finishGroupRecording === 'function') {
						pending.media = item.media
						await finishGroupRecording(state, pending, target)
						return
					}
				}
			}

			state.items.push(item)
			if (currentFlow) {
				currentFlow.recordingCount = Math.max(
					currentFlow.recordingCount || 0,
					state.items.filter((entry) => entry.recordingId).length,
				)
			}
			state.focused = item.id
			state.pending = null
			state.stage = 'done'
			item.resultTab = 'Process'
			state.view = 'analysis'
			state.allExplicit = false
			hideNativeBrowser()
			state.browserElement.hidden = true
			renderRecordingWorkspace()
			if (typeof window.startFlowLinkAIAdvice === 'function') void window.startFlowLinkAIAdvice({ mode: 'recording-complete', items: [item], reason: 'The recording has stopped. Review the initial recording, captured steps, target evidence, navigation and cross-tab/system transitions. Give actionable advice for improving replay reliability. Do not generate a refined material until the user explicitly asks.' })
		} catch (err) {
			console.error('[bridge] 停止录制失败：', err)
			state.pending = null
			state.stage = 'done'
			renderRecordingWorkspace()
		}
	}

	/** 为原生标签页操作和仅发生在界面中的操作保留录制回退元数据。 */
	captureBrowserAction = function (action) {
		const state = recordingSession()
		if (!action || state.stage !== 'recording' || !state.pending) return
		state.pending.actions ||= []
		state.pending.actions.push(action)
	}

	/** 重新录制某个流程组，或在流程组之前/之后添加录制。
	 * 由 bridge.js 覆盖：index.html 中的原实现引用了局部 window.flowlink 句柄（F），
	 * 该句柄在此处不可见。 */
	beginGroupRecording = async function (item, groupId, mode) {
		// 准备过程是受保护的多步状态转换：先恢复起始页，再回放到选定流程组的边界，
		// 最后在回放所得的原生页面上开始捕获，不再导航离开该页面。
		const state = recordingSession()
		if (state.stage === 'recording' || state.groupPreparing) return
		const group = ensureProcessGroups(item).find((g) => g.id === groupId)
		if (!group) return

		const message =
			mode === 'replace'
				? `Re-record node ${group.number}? This will replace its recorded steps.`
				: mode === 'before'
					? 'Add a new recording before this node?'
					: 'Add a new recording after this node?'
		if (!(await confirmWorkspaceAction(message))) return

		state.groupPreparing = true
		state.aiOpen = false
		state.view = 'browser'
		try {
			let flow = null
			if (item.flowFile) flow = await F.flow.load(item.flowFile)
			const flowSteps = flow ? flatFlowSteps(flow.steps) : []
			const boundary = group.start + (mode === 'after' ? group.count : 0)
			const stepCount = Math.min(boundary, flowSteps.length)
			let targetUrl = flow?.meta?.env?.startUrl || item.url || recordingTestURL
			if (!targetUrl || targetUrl === 'about:blank') targetUrl = recordingTestURL

			while (state.browserTabs.length > 1) {
				const extra = state.browserTabs[state.browserTabs.length - 1]
				try {
					await F.browser.closeTab(extra.nativeId || extra.id)
				} catch {}
				state.browserTabs.pop()
			}
			const page = state.browserTabs[0]
			if (!page) throw new Error('No browser page is available for group recording.')
			state.activeBrowserTab = page.id
			page.nativeId = 'browser'
			page.url = targetUrl
			page.draftURL = targetUrl
			page.history = [targetUrl]
			page.historyIndex = 0
			state.url = targetUrl
			state.route = targetUrl.match(/^local:\/\/procurement\/(suppliers|draft|receipts)$/)?.[1] || ''
			syncBrowserSession(state)
			renderRecordingWorkspace()

			const actualUrl = await F.browser.restart(targetUrl)
			page.url = actualUrl || targetUrl
			page.draftURL = page.url
			syncBrowserSession(state)

			if (stepCount > 0) {
				// 从起始页回放到分组边界；回放失败时不启动新捕获，统一进入下方回滚路径。
				if (!item.recordingId) throw new Error('The recording needed for prefix replay is unavailable.')
				const replay = await F.playback.runPrefix({
					taskCode: currentFlow?.code || activeFlowKey,
					recordingId: item.recordingId,
					stepCount,
				})
				if (!replay?.ok) {
					const failed = replay?.steps?.find((step) => step.status === 'fail')
					throw new Error(failed?.error?.message || replay?.error || 'Prefix playback failed.')
				}
				const activeNativeId = replay.tabIds?.[replay.currentPageIndex ?? 0]
				if (activeNativeId) {
					// 前缀执行可能切换过标签页，开始录制前必须将 UI 活动页与引擎当前页对齐。
					const active = state.browserTabs.find((tab) => tab.nativeId === activeNativeId)
					if (!active) throw new Error('The replayed active tab is unavailable for recording.')
					state.activeBrowserTab = active.id
					await F.browser.switchTab(activeNativeId)
				}
			}

			syncBrowserSession(state)
			state.pending = {
				reRecordTarget: item.id,
				groupId,
				groupMode: mode,
				actions: [],
				startedAt: Date.now(),
			}
			state.stage = 'ready'
			state.view = 'browser'
			state.focused = item.id
			renderRecordingWorkspace()
			await startBrowserRecording({ preservePage: true })
		} catch (err) {
			console.error('[bridge] 节点重录准备失败：', err)
			// 任一准备步骤失败都清除临时捕获信息，回到原录制项的分析视图。
			state.pending = null
			state.stage = 'done'
			state.view = 'analysis'
			state.focused = item.id
			item.resultTab = 'Process'
			hideNativeBrowser()
			renderRecordingWorkspace()
			alert('Unable to prepare group recording: ' + (err?.message || String(err)))
		} finally {
			state.groupPreparing = false
			updateRecordingActionButton()
		}
	}

	/** 重置浏览器工作区，但不删除已完成的录制项。 */
	resetTestBrowser = async function (item) {
		// Test 模式共用一个原生浏览器。每个会话只保留一个重置 Promise，
		// 避免工作区重复渲染时并发重置浏览器。
		if (!item?.id) return
		const state = recordingSession()
		if (state.testResetPromise) return state.testResetPromise
		const resetting = (async () => {
			try {
				if (state.stage === 'recording') await finishBrowserRecording()
				state.pending = null
				state.testBrowserResetKey = item.id
				while (state.browserTabs.length > 1) {
					const extra = state.browserTabs[state.browserTabs.length - 1]
					try {
						await F.browser.closeTab(extra.nativeId || extra.id)
					} catch {}
					state.browserTabs.pop()
				}
				const page = state.browserTabs[0]
				if (!page) throw new Error('No browser page is available for Test mode.')
				page.nativeId = 'browser'
				state.activeBrowserTab = page.id
				let startUrl = item.url || recordingTestURL
				if (item.flowFile) {
					try {
						const flow = await F.flow.load(item.flowFile)
						startUrl = flow?.meta?.env?.startUrl || startUrl
					} catch {}
				}
				page.url = startUrl
				page.draftURL = startUrl
				page.history = [startUrl]
				page.historyIndex = 0
				syncBrowserSession(state)
				const actualUrl = await F.browser.restart(startUrl)
				page.url = actualUrl || startUrl
				page.draftURL = page.url
				page.history = [page.url]
				page.historyIndex = 0
			} catch (err) {
				console.error('[bridge] 重置 Test 浏览器失败：', err)
			} finally {
				const remainInTest = state.testBrowserResetKey === item.id
				state.pending = null
				state.stage = 'done'
				state.view = 'analysis'
				if (remainInTest) item.resultTab = 'Test'
				if (activeBrowserPage(state)) syncBrowserSession(state)
				renderSummaryWorkspace()
			}
		})()
		state.testResetPromise = resetting
		try {
			await resetting
		} finally {
			state.testResetPromise = null
		}
	}

	resetRecordingForNewSession = async function () {
		// 新捕获前复用第一个原生标签页并关闭其余标签页。
		// 这里只重置浏览器导航状态，已完成的录制项仍保留。
		const state = recordingSession()
		state.pending = null
		state.focused = null
		state.view = 'browser'
		state.stage = 'ready'
		state.allExplicit = false

		while (state.browserTabs.length > 1) {
			const extra = state.browserTabs[state.browserTabs.length - 1]
			extra.frame?.remove()
			try {
				await F.browser.closeTab(extra.nativeId || extra.id)
			} catch (err) {
				console.error('[bridge] 关闭额外标签页失败：', err)
			}
			state.browserTabs.pop()
		}

		const page = state.browserTabs[0] || createBrowserPage(recordingTestURL, false)
		if (!state.browserTabs.includes(page)) state.browserTabs.push(page)
		state.activeBrowserTab = page.id
		page.showGuide = false
		page.url = recordingTestURL
		page.draftURL = recordingTestURL
		page.route = ''
		page.history = [recordingTestURL]
		page.historyIndex = 0
		page.frame?.removeAttribute('srcdoc')

		try {
			await F.browser.switchTab(page.nativeId || 'browser')
			await navigateRecordingBrowser(recordingTestURL, false, page)
		} catch (err) {
			console.error('[bridge] 重置浏览器标签页失败：', err)
		}
		syncBrowserSession(state)
		updateBrowserChrome()
		renderRecordingWorkspace()
	}

	/** addBrowserPage：创建独立的 Electron WebContentsView 标签页 */
	addBrowserPage = async function () {
		// 等待创建原生标签页前先登记渲染器占位页，以便异步标签页事件能找到对应页面。
		// 创建失败时回滚占位页，并恢复此前活动的页面。
		const state = recordingSession()
		const previousActiveId = state.activeBrowserTab
		const previousPage = activeBrowserPage(state)
		const previousUrl = previousPage?.url

		const page = createBrowserPage(recordingTestURL, false)
		// 创建原生标签页前先把新页面加入会话状态，确保异步的 browser:urlChanged
		// 事件路由到新页面，而不是误更新此前的活动标签页。
		state.browserTabs.push(page)
		state.activeBrowserTab = page.id
		syncBrowserSession(state)

		let nativeId = ''
		try {
			const result = await F.browser.createTab()
			nativeId = result?.tabId || ''
			page.nativeId = nativeId
			if (result?.url) {
				const initialUrl = result.url === 'about:blank' ? '' : result.url
				page.url = initialUrl
				page.draftURL = initialUrl
				page.history = initialUrl ? [initialUrl] : ['']
				page.historyIndex = 0
			}
		} catch (err) {
			// 回滚：移除占位页面，并恢复此前的活动标签页。
			const index = state.browserTabs.indexOf(page)
			if (index >= 0) state.browserTabs.splice(index, 1)
			state.activeBrowserTab = previousActiveId
			syncBrowserSession(state)
			updateBrowserChrome()
			console.error('[bridge] 创建浏览器标签页失败：', err)
			return
		}

		await F.browser.switchTab(nativeId)
		syncBrowserSession(state)
		updateBrowserChrome()
		// 原生页面挂载后，录制器会发出 openTab 事件；此处不要重复记录。

		// 防御性校验：确保此前活动标签页仍保留原来的 URL。
		if (previousPage && previousUrl !== undefined) {
			previousPage.url = previousUrl
			previousPage.draftURL = previousPage.draftURL || previousUrl
		}

		$('recordingAddress')?.focus()
	}
	switchBrowserPage = async function (id) {
		const state = recordingSession()
		const page = state.browserTabs.find((item) => item.id === id)
		if (!page || id === state.activeBrowserTab) return
		state.activeBrowserTab = id
		if (!page.nativeId) page.nativeId = 'browser'
		await F.browser.switchTab(page.nativeId)
		syncBrowserSession()
		updateBrowserChrome()
		captureBrowserAction({ type: 'tab-switch', tabId: page.nativeId, url: page.url })
	}
	closeBrowserPage = async function (id) {
		const state = recordingSession()
		const index = state.browserTabs.findIndex((item) => item.id === id)
		if (index < 0) return
		const page = state.browserTabs[index]
		if (state.browserTabs.length === 1) return
		await F.browser.closeTab(page.nativeId)
		state.browserTabs.splice(index, 1)
		if (state.activeBrowserTab === id) {
			state.activeBrowserTab = state.browserTabs[Math.min(index, state.browserTabs.length - 1)].id
			const next = activeBrowserPage(state)
			await F.browser.switchTab(next.nativeId || 'browser')
		}
		syncBrowserSession()
		updateBrowserChrome()
		// 页面关闭监听器会向引擎录制提供 closeTab 操作。
	}

	// 旧「canvas + MediaRecorder 合成 webm」管线已随截屏管线一并删除：
	// 录制视频由主进程的 rrweb DOM 事件录制产出（recording:loadRrweb 回放）。
	// 此处保留 no-op 覆盖，压住 app.js 原型的同名实现。
	startRecordingMedia = function () {}
	stopRecordingMedia = async function () {
		return { videoURL: '', screenshots: [] }
	}
	requestRecordingSnapshot = function () {}

	/* ================================================================
	 * 5. 步骤转换：引擎 Flow.Step → UI 显示格式
	 * ================================================================ */

	function elementLabel(step) {
		const t = step.target
		if (!t) return ''
		return (
			t.observed?.accessibleName ||
			t.observed?.attributes?.['aria-label'] ||
			t.observed?.attributes?.['placeholder'] ||
			t.observed?.attributes?.['name'] ||
			t.observed?.text ||
			t.description ||
			t.observed?.tag ||
			''
		)
	}

	function flowStepToText(step) {
		const label = elementLabel(step)
		let text
		switch (step.kind) {
			case 'navigate':
				text = `打开 ${step.url}`
				break
			case 'click':
				text = `点击【${label}】`
				break
			case 'input':
				text = `在【${label}】中填写：${step.value}`
				break
			case 'select':
				text = `在【${label}】中选择：${step.value}`
				break
			case 'key':
				text = `在【${label || '页面'}】上按 ${step.key}`
				break
			case 'hover':
				text = `悬停【${label}】`
				break
			case 'scroll':
				text = `滚动页面`
				break
			case 'switchTab':
				text = `切换到标签页 ${(step.index || 0) + 1}`
				break
			case 'openTab':
				text = `打开新标签页${step.url ? ` ${step.url}` : ''}`
				break
			case 'closeTab':
				text = `关闭标签页 ${(step.index || 0) + 1}`
				break
			case 'dialog':
				text = `${step.action === 'accept' ? '确认' : '关闭'}对话框`
				break
			case 'upload':
				text = `上传文件到【${label}】`
				break
			case 'wait':
				text = `等待页面稳定`
				break
			case 'assert':
				text = `断言【${label}】`
				break
			case 'extract':
				text = `提取【${label}】`
				break
			default:
				text = step.kind || '未知操作'
		}
		return step.page?.index > 0 ? `[Tab ${step.page.index + 1}] ${text}` : text
	}

	function flowStepToDetail(step) {
		return {
			type: step.kind,
			target: elementLabel(step),
			value: step.value || step.key || step.url || '',
			tab: step.page?.index > 0 ? step.page.index + 1 : 1,
			url: step.url || '',
		}
	}

	function urlLabel(url) {
		if (!url) return ''
		try {
			const parsed = new URL(url)
			return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
		} catch {
			return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
		}
	}

	/** 在每个标签页内按 URL 分组；切换离开后再返回相同标签页/URL 时，可形成新的节点。 */
	function buildGroupsFromSteps(steps) {
		// 按页面索引分别追踪最近的 URL。若中间执行过其他步骤后才返回原标签页/URL，
		// 则开始一个新的连续分组。
		const groups = []
		let current = null
		let currentTab = 0
		const currentUrlByTab = new Map()
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]
			const tab = step.page?.index ?? 0
			if ((step.kind === 'navigate' || step.kind === 'openTab') && step.url) {
				currentUrlByTab.set(tab, step.url)
			}
			const url = currentUrlByTab.get(tab) || ''
			const key = `${tab}\n${url}`
			if (!current || current.key !== key) {
				if (current && current.count > 0) groups.push(current)
				currentTab = tab
				current = {
					id: 'group-' + (++processGroupSequence),
					name: url ? `Tab ${tab + 1} · ${urlLabel(url)}` : `Tab ${tab + 1}`,
					count: 0,
					tab,
					url,
					key,
				}
			}
			current.count++
		}
		if (current && current.count > 0) groups.push(current)
		return groups.length ? groups : [{ id: 'group-1', name: '操作步骤', count: steps.length }]
	}
	// app.js 的 Process 视图在无 processFlow 的录制项（重启后恢复等）上复用
	// 同一套“按标签页/URL 分组”，组名来自真实页面而非演示种子。
	window.buildGroupsFromSteps = buildGroupsFromSteps

	/* ================================================================
	 * 6. 列表 Run / Delete：启用并接线 IPC
	 * ================================================================ */

	/** 覆盖列表行操作的禁用规则：Run 需要任务启用且有录制，Delete 不再禁用 */
	flowRowActionDisabled = function (name, task) {
		if (name !== 'run') return false
		const hasRecordings = task && (task.recordingCount || task.recordings?.length || 0) > 0
		return !task?.enabled || !hasRecordings
	}

	/** 行操作点击：扩展 Run / Delete */
	const _origFlowRowsClick = $('flowRows').onclick
	$('flowRows').onclick = function (e) {
		const link = e.target.closest('[data-open]')
		const edit = e.target.closest('[data-action="edit"]')
		const run = e.target.closest('[data-action="run"]')
		const del = e.target.closest('[data-action="delete"]')
		if (link) {
			e.preventDefault()
			openDrawer(link.dataset.open, link)
		} else if (edit) {
			openDrawer(edit.dataset.code, edit)
		} else if (run) {
			runFlow(e.target.closest('[data-code]').dataset.code)
		} else if (del) {
			deleteFlow(e.target.closest('[data-code]').dataset.code)
		}
	}

	/** Run：打开 Drawer → Design → 用最近录制回放 */
	// 展平收敛：本文件原有一份 flatFlowSteps 实现，与 app.js 的 executableFlowSteps
	// 统一到 renderer/flow-graph.js 的唯一实现（含 flattenedStepId 标注）。
	function flatFlowSteps(steps) {
		return FlowGraph.flattenFlowSteps(steps).steps
	}

	function findTestItem() {
		const state = recordingSession()
		return state.items.find((item) => item.id === state.focused) || null
	}

	/**
	 * 当前回放的归属域（发起时的 activeFlowKey + 录制项 id）。
	 * 回放可能在用户关闭本 taskflow、切到另一个 taskflow 之后才结束：
	 * playback:* 事件处理器若用 findTestItem() 在「当前会话」里找目标，会把
	 * 旧运行的结果写到新会话的录制项上（覆盖 testResults、并对错误的录制发起
	 * 失败诊断，表现为新 taskflow 布局错乱）。所有回放事件都必须先通过
	 * playbackScopedItem() 校验归属。
	 */
	let activePlaybackScope = null
	const playbackScopedItem = () => {
		if (!activePlaybackScope || activeFlowKey !== activePlaybackScope.code) return null
		const item = findTestItem()
		return item && item.id === activePlaybackScope.itemId ? item : null
	}
	/**
	 * assisted 循环（AI 单步接管编排，runAiAssistedTest）状态：循环运行期间非空。
	 * playback:done / aiDone / error 处理器据此区分「循环中的中间段」与「终点」：
	 * 中间段不清运行标记、不写终态、不触发 AI 诊断/修复，收尾由循环统一做。
	 */
	let assistedLoop = null
	const clearStaleRunFlag = () => {
		// 迟到事件落到别的会话时，把发起录制的运行标记就地清掉，
		// 避免重新打开原 taskflow 时录制项永远显示"运行中"。
		const scope = activePlaybackScope
		if (!scope) return
		const owner = recordingSessions.get(scope.code)
		const origin = owner?.items.find((entry) => entry.id === scope.itemId)
		if (origin) origin.testRunning = false
		activePlaybackScope = null
	}

	window.runFlowlinkTest = async function (item) {
		// 调用回放前先显示运行状态；异步进度事件会推进步骤标记，
		// 错误则关联到当前执行的步骤。
		if (!item?.recordingId || item.testRunning) return
		const state = recordingSession()
		// 入口归属校验：迟到的调用方（如 Test 自动执行的等待）可能带着别的
		// taskflow 的录制项过来；用当前 taskflow 的 code + 旧录制 id 调 IPC
		// 会被主进程以「找不到该录制」拒绝，还会把视图拽回旧 Test 态。
		if (!state.items.includes(item)) {
			console.warn('[bridge] 忽略跨 taskflow 的测试启动请求')
			return
		}
		state.playbackInFlight = true
		const code = currentFlow?.code || activeFlowKey
		try {
			const flow = await F.flow.load(item.flowFile)
			const flat = FlowGraph.flattenFlowSteps(flow?.steps || [])
			item.testFlowSteps = flat.steps
			item.testFlowIndexById = flat.indexById
			item.testResults = item.testFlowSteps.map(() => ({ status: 'pending' }))
			item.testRunning = true
			activePlaybackScope = { code: activeFlowKey, itemId: item.id }
			if (item.testFlowSteps.length) item.testResults[0] = { status: 'running' }
			item.resultTab = 'Test'
			renderSummaryWorkspace()
			const variables = await window.referenceVariablesForReplay(item)
			await F.playback.run({ taskCode: code, recordingId: item.recordingId, variables })
		} catch (err) {
			item.testRunning = false
			state.playbackInFlight = false
			const message = err instanceof Error ? err.message : String(err)
			const runningIndex = item.testResults?.findIndex((result) => result.status === 'running') ?? -1
			if (runningIndex >= 0) item.testResults[runningIndex] = { status: 'fail', error: { message } }
			renderSummaryWorkspace()
		}
	}

	window.stopFlowlinkTest = async function (item) {
		if (!item?.testRunning) return
		// assisted 循环中：置停止信号并中止当前段/接管；收尾由循环统一处理
		// （中途清标记会让循环的后续段失去互斥保护）。
		const inAssistedLoop = !!(assistedLoop && assistedLoop.item === item)
		if (inAssistedLoop) assistedLoop.stopRequested = true
		try {
			await F.playback.stop()
		} catch (err) {
			console.error('[bridge] 停止测试失败：', err)
		}
		if (inAssistedLoop) return
		item.testRunning = false
		recordingSession().playbackInFlight = false
		const runningIndex = item.testResults?.findIndex((result) => result.status === 'running') ?? -1
		if (runningIndex >= 0) item.testResults[runningIndex] = { status: 'fail', error: { message: 'Stopped by user' } }
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
	}

	/** AI 全量接管（次要入口）：Test 失败后从第一个失败步骤起，把剩余步骤全部交给
	 * browser-use agent。默认入口是 runAiAssistedTest（单步接管 + 程序恢复循环）。 */
	window.aiContinueFlowlinkTest = async function (item) {
		if (!item?.recordingId || item.testRunning) return
		const state = recordingSession()
		const code = currentFlow?.code || activeFlowKey
		const results = item.testResults || []
		const failedIndex = results.findIndex((result) => result && result.status === 'fail')
		const fromStepIndex = failedIndex >= 0 ? failedIndex : 0
		try {
			item.testRunning = true
			state.playbackInFlight = true
			activePlaybackScope = { code: activeFlowKey, itemId: item.id }
			renderSummaryWorkspace()
			const variables = await window.referenceVariablesForReplay(item)
			const failureSummary = results[fromStepIndex]?.error?.message || ''
			await F.playback.aiContinue({
				taskCode: code,
				recordingId: item.recordingId,
				fromStepIndex,
				mode: 'remaining',
				variables,
				...(failureSummary ? { failureSummary } : {}),
			})
		} catch (err) {
			item.testRunning = false
			state.playbackInFlight = false
			const message = err?.message || String(err)
			renderSummaryWorkspace()
			if (typeof appendAIMessage === 'function') {
				appendAIMessage(item, 'assistant', `AI takeover could not start: ${message}`)
			} else {
				console.error('[bridge] AI 接管启动失败：', message)
			}
		}
	}

	/** AI 辅助测试（默认入口）编排：程序回放 → 某步失败 → AI 单步接管该步 →
	 * 成功后从下一步恢复程序回放（resume，浏览器现场保留）→ 再失败再单步，循环。
	 * 界限：单轮 Test 最多 6 次单步介入；同一单步两败 → 回退一次全量接管
	 * （remaining 模式，内部自带 free-run 降级）。中间段的 playback:done 不写
	 * 失败 lastRun（主进程按 resume 段抑制），lastRun 与自动 repair 在循环
	 * 全部结束后统一落一次。 */
	window.runAiAssistedTest = async function (item) {
		if (!item?.recordingId || item.testRunning) return
		const state = recordingSession()
		if (state.playbackInFlight || assistedLoop || item.repairInFlight) return
		if (!state.items.includes(item)) {
			console.warn('[bridge] 忽略跨 taskflow 的 AI 辅助测试启动请求')
			return
		}
		const code = currentFlow?.code || activeFlowKey
		assistedLoop = { item, recordingId: item.recordingId, stopRequested: false, aiDoneResolve: null }
		item.assistedLoopActive = true
		state.playbackInFlight = true
		/** 终态收尾：running 残留步按语义归位（用户停止/异常 → fail；否则回
		 *  pending，未执行步骤保持 Pending），清运行标记与归属域。 */
		const finalize = (errorMessage) => {
			const interrupted = !!(assistedLoop && assistedLoop.stopRequested) || !!errorMessage
			const results = item.testResults || []
			for (let index = 0; index < results.length; index++) {
				if (results[index]?.status === 'running') {
					results[index] = interrupted
						? { status: 'fail', error: { message: errorMessage || 'Stopped by user' } }
						: { status: 'pending' }
				}
			}
			assistedLoop = null
			item.assistedLoopActive = false
			item.testRunning = false
			state.playbackInFlight = false
			activePlaybackScope = null
		}
		let fallbackUsed = false
		let aiAssistedAny = false
		try {
			const flow = await F.flow.load(item.flowFile)
			const flat = FlowGraph.flattenFlowSteps(flow?.steps || [])
			item.testFlowSteps = flat.steps
			item.testFlowIndexById = flat.indexById
			item.testResults = item.testFlowSteps.map(() => ({ status: 'pending' }))
			item.testRunning = true
			item.resultTab = 'Test'
			activePlaybackScope = { code: activeFlowKey, itemId: item.id }
			if (item.testFlowSteps.length) item.testResults[0] = { status: 'running' }
			renderSummaryWorkspace()
			const variables = await window.referenceVariablesForReplay(item)
			const MAX_SINGLE_INTERVENTIONS = 6

			/** 从一段运行结果里找第一个 fail 步骤的扁平下标（-1 = 无失败）。 */
			const firstFailIndex = (result) => {
				for (const step of result?.steps || []) {
					if (step.status !== 'fail') continue
					const mapped = item.testFlowIndexById?.get(step.stepId)
					if (mapped !== undefined) return mapped
					const fallback = (item.testFlowSteps || []).findIndex(
						(s) => (s.flattenedStepId || s.id) === step.stepId,
					)
					if (fallback >= 0) return fallback
				}
				return -1
			}
			/** 一段运行的结果并入 testResults：pass/fail 始终写；skip 只写 pending/
			 *  running 槽——bypassed 前段在早前段已真实执行过，原结果（含 AI 徽标）
			 *  保留（Pending/Skipped 规约：Skipped 仅=分支未走/可选未生效）。 */
			const mergeRunResult = (result) => {
				const stepById = new Map()
				for (const step of result?.steps || []) {
					if (typeof step.stepId === 'string' && !stepById.has(step.stepId)) stepById.set(step.stepId, step)
				}
				const results = item.testResults || []
				const flowSteps = item.testFlowSteps || []
				for (let index = 0; index < flowSteps.length; index++) {
					const final = stepById.get(flowSteps[index].flattenedStepId || flowSteps[index].id)
					if (!final) continue
					if (final.status === 'fail') {
						results[index] = { status: 'fail', error: final.error }
					} else if (final.status === 'pass') {
						if (!results[index]?.ai) results[index] = { status: 'pass' }
					} else if (
						final.status === 'skip' &&
						(!results[index] || results[index].status === 'pending' || results[index].status === 'running')
					) {
						results[index] = { status: 'skip' }
					}
				}
			}
			/** 等待下一次 playback:aiDone（事件处理器 resolve；见 aiDone 处理器）。 */
			const waitAiDone = () =>
				new Promise((resolve) => {
					assistedLoop.aiDoneResolve = resolve
				})
			const runPhase = async (resumeFrom) => {
				const runOpts = { taskCode: code, recordingId: item.recordingId, variables }
				if (resumeFrom > 0) runOpts.resumeFromStepIndex = resumeFrom
				const result = await F.playback.run(runOpts)
				mergeRunResult(result)
				renderSummaryWorkspace()
				return result
			}
			const takeoverPhase = async (fromStepIndex, mode, failureSummary) => {
				const done = waitAiDone()
				await F.playback.aiContinue({
					taskCode: code,
					recordingId: item.recordingId,
					fromStepIndex,
					mode,
					variables,
					...(failureSummary ? { failureSummary } : {}),
				})
				return await done
			}

			let interventions = 0
			const attemptsByStep = new Map()
			let result = await runPhase(0)
			while (true) {
				if (assistedLoop.stopRequested) break
				const failIndex = firstFailIndex(result)
				if (failIndex < 0) {
					// 本段全部通过；若段本身异常失败（如 startUrl 打开失败，无具体
					// 步骤槽位），提示后结束——没有可接管的失败步骤。
					if (result && result.ok === false && result.error && typeof appendAIMessage === 'function') {
						appendAIMessage(item, 'assistant', `本段运行异常结束：${result.error}`)
					}
					break
				}
				const attempts = (attemptsByStep.get(failIndex) || 0) + 1
				attemptsByStep.set(failIndex, attempts)
				const failureSummary = item.testResults[failIndex]?.error?.message || ''
				if (attempts >= 2) {
					// 同一单步两败：回退一次全量接管（remaining 模式，内部自带 free-run 降级）。
					// 其 aiDone 即循环终点（处理器做终态清理并可自动触发 repair）。
					fallbackUsed = true
					if (typeof appendAIMessage === 'function') {
						appendAIMessage(
							item,
							'assistant',
							`第 ${failIndex + 1} 步两次 AI 单步接管未成功，回退为 AI 接管全部剩余步骤…`,
						)
					}
					renderSummaryWorkspace()
					await takeoverPhase(failIndex, 'remaining', failureSummary)
					break
				}
				if (interventions >= MAX_SINGLE_INTERVENTIONS) {
					if (typeof appendAIMessage === 'function') {
						appendAIMessage(
							item,
							'assistant',
							`本轮 AI 单步介入已达上限（${MAX_SINGLE_INTERVENTIONS} 次），辅助执行停止；剩余失败步骤可用「AI: run all remaining」全量接管或人工处理。`,
						)
					}
					break
				}
				interventions += 1
				if (typeof appendAIMessage === 'function') {
					appendAIMessage(
						item,
						'assistant',
						`第 ${failIndex + 1} 步失败，AI 单步接管（第 ${interventions}/${MAX_SINGLE_INTERVENTIONS} 次介入）…`,
					)
				}
				renderSummaryWorkspace()
				const aiDone = await takeoverPhase(failIndex, 'single', failureSummary)
				if (assistedLoop.stopRequested) break
				if (!aiDone?.ok) continue // 单步失败（内部已含两次尝试）：回到同一步，两败即回退全量
				aiAssistedAny = true
				result = await runPhase(failIndex + 1)
			}
			finalize(null)
			renderSummaryWorkspace()
			// 一次性触发自动 repair：全量回退时 aiDone 处理器已触发（fallbackUsed）；
			// 其余结局（最终段成功/介入上限）在此统一触发一次。
			if (
				!fallbackUsed &&
				aiAssistedAny &&
				item.lastTakeover?.aiCompleted > 0 &&
				!item.repairInFlight &&
				typeof window.aiRepairFlowAfterTakeover === 'function'
			) {
				void window.aiRepairFlowAfterTakeover(item)
			}
		} catch (err) {
			const message = err?.message || String(err)
			console.error('[bridge] AI 辅助测试失败：', message)
			finalize(message)
			if (typeof appendAIMessage === 'function') {
				appendAIMessage(item, 'assistant', `AI-assisted test stopped: ${message}`)
			}
			renderSummaryWorkspace()
		}
	}

	/** AI 接管后的自动流程修复：带失败信息与 AI 执行证据重跑细化管线，另存为全新录制（原始流程不动）。 */
	window.aiRepairFlowAfterTakeover = async function (item) {
		if (!item?.recordingId || !item.lastTakeover?.aiCompleted) return
		if (item.testRunning || recordingSession().playbackInFlight) return
		if (item.repairInFlight) return
		item.repairInFlight = true
		const code = currentFlow?.code || activeFlowKey
		const results = item.testResults || []
		const failedSteps = []
		for (let index = 0; index < (item.testFlowSteps?.length || 0); index++) {
			const step = item.testFlowSteps[index]
			const result = results[index]
			if (step && result?.status === 'fail')
				failedSteps.push({
					stepId: step.flattenedStepId || step.id,
					label: step.label || step.text || '',
					error: result.error?.message || '',
				})
		}
		const aiSteps = []
		for (let index = 0; index < (item.testFlowSteps?.length || 0); index++) {
			const step = item.testFlowSteps[index]
			if (results[index]?.ai && results[index].status === 'pass')
				aiSteps.push(step?.label || step?.flattenedStepId || '')
		}
		if (typeof appendAIMessage === 'function')
			appendAIMessage(item, 'assistant', 'Updating the flow from the AI takeover result…')
		renderSummaryWorkspace()
		try {
			const repair = await F.pi.repairFlow({
				taskCode: code,
				recordingId: item.recordingId,
				takeover: {
					ok: item.lastTakeover.ok,
					summary: item.lastTakeover.summary,
					aiCompleted: item.lastTakeover.aiCompleted,
					failedSteps,
					aiSteps,
					...(item.lastTakeover.artifactDir
						? { artifactDir: item.lastTakeover.artifactDir }
						: {}),
				},
			})
			// 不覆盖当前录制：修复后的完整 Flow（主进程已 parseFlow 校验）另存为
			// 全新录制（persistMerged → saveFlow 落盘前再次完整校验），原始流程与
			// 本次测试结果保持原样。
			const now = new Date()
			const pad = (value) => String(value).padStart(2, '0')
			const base =
				'REPAIRED-' +
				pad(now.getMonth() + 1) +
				pad(now.getDate()) +
				'-' +
				pad(now.getHours()) +
				pad(now.getMinutes())
			const state = recordingSession(code)
			const names = new Set(state.items.map((entry) => entry.name))
			let name = base
			for (let suffix = 2; names.has(name); suffix++) name = `${base} (${suffix})`
			const recording = await F.recording.persistMerged({
				taskCode: code,
				flow: repair.flow,
				name,
			})
			item.lastTakeover = null
			// 与 ai:autoRefine 同款刷新：按 recordingId 保留现有条目（测试结果与聊天
			// 都在原对象上），新条目追加进列表。
			state.detailsLoaded = false
			await window.loadTaskDetails(code, { force: true })
			if (currentFlow && currentFlow.code === code) {
				currentFlow.recordingCount = Math.max(
					currentFlow.recordingCount || 0,
					state.items.filter((entry) => entry.recordingId).length,
				)
			}
			if (typeof appendAIMessage === 'function') {
				appendAIMessage(
					item,
					'assistant',
					`Created a new repaired flow: ${recording.name}. The original flow was preserved. ${repair.summary || ''}` +
						(repair.risks?.length ? `\nRisks: ${repair.risks.join('；')}` : ''),
				)
			}
			renderSummaryWorkspace()
			// ---- Phase 5 闭环：REPAIRED 生成后自动回跑一轮 Test（最多 2 轮，UI 明示轮次）----
			const newItem = state.items.find((entry) => entry.recordingId === recording.id)
			const round = (item.autoVerifyRound || 0) + 1
			if (newItem) newItem.autoVerifyRound = round
			if (newItem && round <= 2) {
				if (typeof appendAIMessage === 'function') {
					appendAIMessage(
						newItem,
						'assistant',
						`自动回跑验证（第 ${round}/2 轮）：正在对修复后的流程运行一次 Test…`,
					)
				}
				renderSummaryWorkspace()
				await window.runFlowlinkTest(newItem)
				const finalResults = newItem.testResults || []
				const hasFail = finalResults.some((result) => result?.status === 'fail')
				if (typeof appendAIMessage === 'function') {
					appendAIMessage(
						newItem,
						'assistant',
						hasFail
							? `自动回跑（第 ${round}/2 轮）仍有失败步骤。可以再次点 AI Continue 接管，或直接人工处理；${round >= 2 ? '自动回跑轮次已用完，之后的 Test 请手动运行。' : '修复链会继续计数轮次。'}`
							: `自动回跑（第 ${round}/2 轮）全部通过，修复后的流程可以直接使用。`,
					)
				}
				renderSummaryWorkspace()
			} else if (typeof appendAIMessage === 'function') {
				appendAIMessage(
					item,
					'assistant',
					'自动回跑轮次已达上限（2 轮），本次修复不再自动运行 Test，请手动验证。',
				)
			}
		} catch (err) {
			const message = err?.message || String(err)
			if (typeof appendAIMessage === 'function')
				appendAIMessage(item, 'assistant', `Flow update failed: ${message}`)
			renderSummaryWorkspace()
		} finally {
			item.repairInFlight = false
		}
	}

	/** 打开 taskflow 工作区时的浏览器重置（全新浏览器语义）：空闲状态下把内嵌
	 * 浏览器还原为该流程起始 URL 的单一新页，清除跨 taskflow 遗留的标签页与
	 * 上一轮运行状态；录制/回放进行中不打扰。 */
	window.resetBrowserToTaskflowStart = async function (code) {
		if (!code) return
		const state = recordingSession(code)
		if (state.stage === 'recording' || state.playbackInFlight) return
		const item = [...state.items]
			.reverse()
			.find((entry) => entry?.recordingId && entry.flowFile)
		let startUrl = ''
		if (item) {
			try {
				startUrl = (await F.flow.load(item.flowFile))?.meta?.env?.startUrl || ''
			} catch {
				// 读不到起始 URL 时走默认地址兜底
			}
		}
		if (!startUrl && typeof recordingTestURL === 'string') startUrl = recordingTestURL
		if (!startUrl) return
		// 异步加载流程文件期间可能已有 Test/录制启动；重启前二次确认空闲。
		if (state.stage === 'recording' || state.playbackInFlight) return
		try {
			await F.browser.restart(startUrl)
		} catch {
			// 重置失败（含回放已启动被主进程拒绝）不打断工作区打开；
			// 后续 Record/Test 各自的重置仍会执行。
		}
	}

	async function runFlow(code) {
		const task = flowData.find((f) => f.code === code)
		if (!task || !(task.recordingCount || task.recordings?.length)) return
		openDrawer(code, null)
		showDrawerTab('Design')
		try {
			await window.loadTaskDetails(code)
			const items = recordingSession(code).items
			const item = items[items.length - 1]
			if (!item?.recordingId) throw new Error('The task has no saved recordings to run.')
			// 列表 Run 与 Test 面板共用同一入口：初始化步骤/结果/运行标记并切到
			// Test 视图后再回放。此前直接调 playback:run，界面没有任何运行反馈，
			// 回放只在后台执行（步骤事件因 testRunning 未置位而被全部丢弃）。
			if (typeof window.runFlowlinkTest !== 'function')
				throw new Error('Test runner is unavailable.')
			await window.runFlowlinkTest(item)
		} catch (err) {
			console.error('[bridge] 回放失败：', err)
		}
	}

	/** Delete：确认后调 IPC 删除 */
	async function deleteFlow(code) {
		if (!window.confirm(`确定删除 ${code}？此操作不可撤销。`)) return
		try {
			await F.tasks.remove(code)
			const idx = flowData.findIndex((f) => f.code === code)
			if (idx >= 0) flowData.splice(idx, 1)
			recordingSessions.delete(code)
			profileDrafts.delete(code)
			render()
		} catch (err) {
			console.error('[bridge] 删除失败：', err)
			alert('删除失败：' + err.message)
		}
	}

	/* ================================================================
	 * 7. 事件监听：URL 变更 / 录制步骤流 / 回放步骤流
	 * ================================================================ */

	/** URL 变更 → 更新地址栏 */
	F.on('browser:urlChanged', ({ url, tabId }) => {
		// 将原生标签页 ID 还原为会话中的页面对象，再同步共享的活动页面镜像，
		// 最后刷新可见的地址栏控件。
		const state = recordingSession()
		const page = tabId
			? state.browserTabs.find((item) => item.nativeId === tabId) || activeBrowserPage()
			: activeBrowserPage()
		if (!page.nativeId && tabId) page.nativeId = tabId
		// 原生事件是导航事实来源；同步该页数据后，再由 syncBrowserSession 更新兼容镜像。
		page.url = url
		page.draftURL = url
		syncBrowserSession()
		const addr = $('recordingAddress')
		if (addr) addr.value = url
		if (state.view !== 'analysis') updateBrowserChrome()
	})

	F.on('browser:tabOpened', async ({ tabId, url, active }) => {
		// 原生弹窗/打开事件可能独立于界面上的 + 按钮到达；
		// 按原生 ID 去重，且只有事件明确表示为活动页时才切换。
		const state = recordingSession()
		const existing = state.browserTabs.find((item) => item.nativeId === tabId)
		if (existing) return
		const page = createBrowserPage(String(url || ''), false)
		page.nativeId = tabId
		page.url = String(url || '')
		page.draftURL = String(url || '')
		page.history = [String(url || '')]
		page.historyIndex = 0
		state.browserTabs.push(page)
		if (active === true) {
			// 等待主进程确认切换后再指定活动页；失败也保留新建页以供后续恢复。
			try {
				await F.browser.switchTab(tabId)
			} catch (err) {
				console.error('[bridge] 切换新标签页失败：', err)
			}
			state.activeBrowserTab = page.id
		} else if (active !== false) {
			state.activeBrowserTab = page.id
		}
		syncBrowserSession()
		updateBrowserChrome()
		// 弹窗或原生打开操作会在 CDP 挂接后由引擎记录。
	})

	// 旧「recording:captureFrame」帧消费已删除：主进程不再有周期性截屏，
	// 录制画面由 rrweb 事件流落盘后在 Record 标签页回放。

	/** 加载状态 → 更新 reload 按钮 */
	F.on('browser:loading', ({ loading }) => {
		const reload = $('recordingReload')
		if (reload) reload.classList.toggle('loading', loading)
	})

	F.on('browser:error', ({ errorDescription, url }) => {
		console.error('[bridge] 浏览器导航失败：', errorDescription, url)
		const address = $('recordingAddress')
		if (address) {
			address.setCustomValidity(errorDescription || 'Navigation failed')
			address.reportValidity()
		}
	})

	/** 录制步骤流 → 更新 pending 计数 */
	F.on('recording:step', (step) => {
		// 这里只维护轻量操作计数，供界面回退和空录制判断使用；
		// 完整的规范步骤以引擎持久化的 Flow 为准。
		const state = recordingSession()
		if (state.pending && state.stage === 'recording') {
			state.pending.actions.push({ type: step.kind })
			/* 实时更新录制列表里的步骤数（如果有 UI 元素显示） */
		}
	})

	/** 录制完成 */
	F.on('recording:done', ({ recording }) => {
		console.log('[bridge] 录制完成事件：', recording)
	})

	/** 自动细化（录制停止后主进程火后即忘生成 REFINED 孪生录制） */
	F.on('ai:autoRefine', (event) => {
		if (!event || typeof event !== 'object') return
		// Pi 未配置属于正常情况：静默跳过，不打扰用户。
		if (event.state === 'skipped') return
		const taskCode = event.taskCode || activeFlowKey
		if (event.state === 'failed') {
			if (typeof window.showFlowlinkNotice === 'function') {
				window.showFlowlinkNotice(`Auto-refine failed: ${event.error || 'unknown error'}`, 'warn')
			}
			return
		}
		if (event.state !== 'done') return
		void (async () => {
			try {
				// 强制重载该任务的录制列表：已存在的条目按 recordingId 保留，新条目追加。
				const state = recordingSession(taskCode)
				state.detailsLoaded = false
				await window.loadTaskDetails(taskCode, { force: true })
				if (currentFlow && currentFlow.code === taskCode) {
					currentFlow.recordingCount = Math.max(
						currentFlow.recordingCount || 0,
						state.items.filter((entry) => entry.recordingId).length,
					)
				}
			} catch (err) {
				console.error('[bridge] 自动细化后刷新录制列表失败：', err)
			}
			if (typeof window.showFlowlinkNotice === 'function') {
				window.showFlowlinkNotice(`${event.name || 'A refined material'} created from the recording`)
			}
		})()
	})

	/** 录制错误 */
	F.on('recording:error', ({ message }) => {
		console.error('[bridge] 录制错误：', message)
		const state = recordingSession()
		if (state.stage === 'recording') {
			state.pending = null
			state.stage = 'ready'
			renderRecordingWorkspace()
			alert('录制失败：' + message)
		}
	})

	/** 回放步骤流 */
	F.on('playback:step', (r) => {
		// 将每条流式结果应用到正在运行的测试项：优先按 stepId 精确对齐
		// （分支跳过后执行顺序与展示顺序不一致，顺序启发式会错位），
		// 找不到时回退到顺序启发式（兼容未带 id 的旧数据/演示数据）。
		// pass 与 skip 都推进 running 标记；fail 停止推进。
		console.log('[bridge] 回放步骤：', r.stepId, r.status, r.ms + 'ms')
		const item = playbackScopedItem()
		if (!item?.testRunning) return
		const results = item.testResults || []
		let resultIndex = -1
		if (typeof r.stepId === 'string') {
			// 优先查展平时建立的 id→index 映射；找不到时回退线性查找
			// （兼容未带 id 的旧数据/演示数据）。
			resultIndex = item.testFlowIndexById?.get(r.stepId) ?? -1
			if (resultIndex < 0) {
				resultIndex = (item.testFlowSteps || []).findIndex(
					(step) => (step.flattenedStepId || step.id) === r.stepId,
				)
			}
		}
		if (resultIndex < 0) {
			const runningIndex = results.findIndex((result) => result.status === 'running')
			resultIndex = runningIndex >= 0 ? runningIndex : results.findIndex((result) => result.status === 'pending')
		}
		if (resultIndex < 0) return
		const existing = results[resultIndex]
		// 已定槽位（pass/fail/skip，含 AI 徽标）不被 skip/pass 事件覆盖：
		// assisted 续跑的 bypassed 前段在早前段已真实执行过，skip 只应落
		// pending/running 槽（Pending/Skipped 规约）；fail 始终写入（新信息）。
		const settled =
			existing && existing.status !== 'pending' && existing.status !== 'running'
		if (r.status === 'fail' || !settled) {
			results[resultIndex] =
				r.status === 'pass'
					? { status: 'pass' }
					: r.status === 'fail'
						? { status: 'fail', error: r.error }
						: r.status === 'skip'
							? { status: 'skip', error: r.error }
							: { status: 'pending', error: r.error }
		}
		if (r.status === 'pass' || r.status === 'skip') {
			// 找下一个待执行槽：把 running 也算「已占」并只把 pending 提为 running，
			// 避免 assisted 续跑的 bypassed skip 突发流把后续槽级联标成 running。
			const nextIndex = results.findIndex(
				(result, index) =>
					index > resultIndex &&
					(!result || result.status === 'pending' || result.status === 'running'),
			)
			if (nextIndex >= 0 && (!results[nextIndex] || results[nextIndex].status === 'pending')) {
				results[nextIndex] = { status: 'running' }
			}
		}
		// assisted 循环中的失败是中间态（循环会决定单步接管/回退），不提前清运行标记。
		if (r.status === 'fail' && !(assistedLoop && assistedLoop.item === item)) item.testRunning = false
		// Test 面板刷新进度；停留在 Process 标签时刷新流程图的回放态叠加
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
	})

	F.on('playback:userOperation', ({ token, stepId, prompt }) => {
		const host = $('playbackUserOperation')
		const label = $('playbackUserOperationPrompt')
		const button = $('playbackUserOperationContinue')
		if (!host || !label || !button || typeof token !== 'string') return
		host.dataset.token = token
		label.textContent = `${stepId}: ${prompt}`
		host.title = `${stepId}: ${prompt}`
		host.hidden = false
		button.onclick = async () => {
			button.disabled = true
			try {
				const resumed = await F.playback.continueUserOperation(token)
				if (!resumed) throw new Error('This user-operation wait is no longer active.')
				host.hidden = true
				delete host.dataset.token
			} catch (error) {
				label.textContent = error?.message || String(error)
			} finally {
				button.disabled = false
			}
		}
	})

	/** 回放完成 */
	F.on('playback:done', (result) => {
		// 最终结果是所有步骤状态的权威来源；先将界面状态与最终结果对齐，
		// 再清除运行标记。事件只允许落回发起运行的录制项（归属域校验）。
		console.log('[bridge] 回放完成：', result.ok ? '成功' : '失败', result.metrics)
		$('playbackUserOperation')?.setAttribute('hidden', '')
		const item = playbackScopedItem()
		if (!item) {
			clearStaleRunFlag()
			return
		}
		// assisted 循环中的段结果是中间态：结果并入（mergeRunResult）与终态清理
		// 都由循环统一做——这里不清运行标记、不发失败诊断，只刷新视图。
		if (assistedLoop && assistedLoop.item === item) {
			if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
			return
		}
		recordingSession().playbackInFlight = false
		activePlaybackScope = null
		// 先清除运行标记，再以最终步骤数组覆盖流式暂存状态，避免终态遗漏或顺序偏差。
		// 按引擎 stepId 建映射（分支跳过后 result.steps 是执行序而非展示序）。
		// 本次 run 没有结果的步骤（失败后未执行/中断）不写槽位，保持原状 Pending；
		// 只有引擎 skip 事件产生的结果才显示 Skipped（分支未走/isOptional 未生效）。
		item.testRunning = false
		const stepById = new Map()
		for (const step of result.steps || []) {
			if (typeof step.stepId === 'string' && !stepById.has(step.stepId)) stepById.set(step.stepId, step)
		}
		const flowSteps = item.testFlowSteps || []
		for (let index = 0; index < flowSteps.length; index++) {
			const final = stepById.get(flowSteps[index].flattenedStepId || flowSteps[index].id)
			if (!final) continue
			item.testResults[index] =
				final.status === 'pass'
					? { status: 'pass' }
					: final.status === 'fail'
						? { status: 'fail', error: final.error }
						: { status: 'skip' }
		}
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
		if (!result.ok && typeof window.startFlowLinkAIAdvice === 'function') {
			const failed = (result.steps || []).filter((step) => step.status === 'fail')
			void window.startFlowLinkAIAdvice({ mode: 'replay-failure', items: [item], reason: 'Replay failed. Diagnose the failed step(s) and the whole procedure using the execution result and captured evidence. Suggest a fix, but do not modify the source material unless the user explicitly requests a refined material.', failureContext: { ok: result.ok, error: result.error, metrics: result.metrics, failedSteps: failed, allResults: result.steps } })
		}
	})

	/** AI 接管进度：单步完成（带 AI 徽标）或单步失败 */
	F.on('playback:aiStep', (event) => {
		const state = recordingSession()
		const item =
			state.items.find((entry) => entry.recordingId === event.recordingId) ||
			playbackScopedItem()
		if (!item) return
		const results = item.testResults || []
		// ok 事件允许覆盖 fail 槽位：AI 单步/全量接管重做的正是程序失败的步骤，
		// 成功后要把 fail 翻转为 pass+ai（AI 徽标）；pass/skip 定局仍不覆盖
		// （迟到/重复事件防护）。!ok 事件维持只写 pending/running 槽。
		const slotOpen = (index, forOk) =>
			Number.isInteger(index) &&
			results[index] &&
			(!results[index].status ||
				results[index].status === 'pending' ||
				results[index].status === 'running' ||
				(forOk && results[index].status === 'fail'))
		/** 下一个待执行槽提为 running；running 视为已占，防突发 skip 流级联标记。 */
		const advanceRunning = (fromIndex) => {
			const nextIndex = results.findIndex(
				(result, index) =>
					index > fromIndex &&
					(!result || result.status === 'pending' || result.status === 'running'),
			)
			if (nextIndex >= 0 && (!results[nextIndex] || results[nextIndex].status === 'pending')) {
				results[nextIndex] = { status: 'running' }
			}
		}
		// 事件按 stepId 对齐（展平收敛后 id→index 映射）；stepIndex 仅作旧事件回退。
		let stepIndex = -1
		if (typeof event.stepId === 'string' && item.testFlowIndexById) {
			const mapped = item.testFlowIndexById.get(event.stepId)
			if (mapped !== undefined) stepIndex = mapped
		}
		if (stepIndex < 0 && Number.isInteger(event.stepIndex)) stepIndex = event.stepIndex
		if (event.ok && event.skipped && slotOpen(stepIndex, true)) {
			// 网关路由跳过（接管前本地求值定子序列）：语义对齐执行器的分支 skip。
			results[stepIndex] = { status: 'skip' }
			advanceRunning(stepIndex)
		} else if (event.ok && event.manual && slotOpen(stepIndex, true)) {
			// manual 步骤：用户在内嵌浏览器完成并确认（无 AI 徽标）。
			results[stepIndex] = { status: 'pass', manual: true }
			advanceRunning(stepIndex)
		} else if (event.ok && slotOpen(stepIndex, true)) {
			results[stepIndex] = { status: 'pass', ai: true, ...(event.freeRun ? { freeRun: true } : {}) }
			advanceRunning(stepIndex)
		} else if (!event.ok && slotOpen(stepIndex, false)) {
			results[stepIndex] = {
				status: 'fail',
				ai: true,
				error: { message: event.error || 'AI could not complete this step' },
			}
			// assisted 循环中的单步失败是中间态（循环决定重试/回退），不提前清运行标记。
			if (!(assistedLoop && assistedLoop.item === item)) item.testRunning = false
		}
		if (event.note && typeof appendAIMessage === 'function') {
			appendAIMessage(item, 'assistant', `AI: ${event.note}`)
		}
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
	})

	/** AI 接管结束：清运行标记并把总结写入聊天 */
	F.on('playback:aiDone', (event) => {
		console.log('[bridge] AI 接管结束：', event.ok ? '完成' : '中止', event.summary)
		const state = recordingSession()
		const item =
			state.items.find((entry) => entry.recordingId === event.recordingId) ||
			playbackScopedItem()
		if (!item) {
			clearStaleRunFlag()
			return
		}
		const isSingle = event.mode === 'single'
		const inLoop = !!(assistedLoop && assistedLoop.item === item)
		// assisted 循环的等待器优先 resolve（循环据此决定重试单步/回退全量/续跑）。
		if (inLoop && assistedLoop.aiDoneResolve) {
			const resolve = assistedLoop.aiDoneResolve
			assistedLoop.aiDoneResolve = null
			resolve(event)
		}
		// single = assisted 循环的中间态：不清运行标记（循环还要继续）；
		// remaining（含循环内回退全量）与非循环路径 = 终态：完整清理。
		if (!inLoop || !isSingle) {
			state.playbackInFlight = false
			activePlaybackScope = null
			item.testRunning = false
		}
		const results = item.testResults || []
		// 接管结束：running 的步骤不会再执行，重置回 pending（接管中断在该步）；
		// 其余未执行步骤保持 Pending——Skipped 仅表示分支未走/isOptional 未生效。
		for (let index = 0; index < results.length; index++) {
			if (results[index]?.status === 'running') results[index] = { status: 'pending' }
		}
		// 记录接管结果：aiCompleted > 0 时自动后台触发流程优化（见下方）。
		// single 模式在循环里逐次发生：槽位跨段保留，直接数 ai+pass 总数即为累计值。
		item.lastTakeover = {
			at: Date.now(),
			ok: !!event.ok,
			summary: String(event.summary || ''),
			aiCompleted: results.filter((result) => result?.ai && result.status === 'pass')
				.length,
			// 接管 artifact 目录：修复链路据此读取 ai-takeover.json 的元素证据（重锚定）；
			// single 逐次覆盖为最新一次（保留历史目录缺省时的早前值）。
			artifactDir: String(event.artifactDir || item.lastTakeover?.artifactDir || ''),
		}
		if (typeof appendAIMessage === 'function') {
			appendAIMessage(
				item,
				'assistant',
				isSingle
					? `${event.ok ? 'AI 完成了该步骤，程序回放从下一步继续。' : 'AI 未能完成该步骤。'} ${event.summary || ''}`
					: `${event.ok ? 'AI takeover completed all remaining steps.' : 'AI takeover stopped.'} ${event.summary || ''}`,
			)
		}
		// 接管有 AI 执行证据时自动在后台优化流程并写回当前录制，无需用户触发；
		// single 的中间态不触发（assisted 循环结束后统一触发一次）。
		if (
			(!inLoop || !isSingle) &&
			item.lastTakeover.aiCompleted > 0 &&
			!item.repairInFlight
		) {
			void window.aiRepairFlowAfterTakeover(item)
		}
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
	})

	/** 回放错误 */
	F.on('playback:error', ({ message }) => {
		console.error('[bridge] 回放错误：', message)
		$('playbackUserOperation')?.setAttribute('hidden', '')
		const item = playbackScopedItem()
		if (!item?.testRunning) return
		// assisted 循环中：段执行的异常经 IPC 返回值带给循环，由循环统一收尾。
		if (assistedLoop && assistedLoop.item === item) return
		recordingSession().playbackInFlight = false
		activePlaybackScope = null
		item.testRunning = false
		const index = item.testResults.findIndex((result) => result.status === 'running')
		if (index >= 0) item.testResults[index] = { status: 'fail', error: { message } }
		// 异常终止后未执行到的步骤保持 Pending（不写任何值）；
		// Skipped 仅来自引擎 skip 事件（分支未走/isOptional 未生效）。
		if (item.resultTab === 'Test' || item.resultTab === 'Process') renderSummaryWorkspace()
		if (typeof window.startFlowLinkAIAdvice === 'function') void window.startFlowLinkAIAdvice({ mode: 'replay-failure', items: [item], reason: 'Replay terminated with an execution error. Analyze the error and procedure, then suggest evidence-backed repairs without changing the source material.', failureContext: { error: message, failedStepIndex: index } })
	})

	/* ================================================================
	 * 8. Drawer 关闭时隐藏内嵌浏览器
	 * ================================================================ */
	const _origCloseDrawer = closeDrawer
	closeDrawer = async function () {
		// 拆除抽屉观察器并恢复原始关闭流程前先隐藏原生视图，
		// 防止它继续覆盖界面。
		const session = recordingSession()
		if (session.stage === 'recording') {
			const empty = !(session.pending?.actions || []).length
			const message = empty ? EMPTY_RECORDING_MESSAGE : 'Stop recording and close?'
			if (!(await confirmWorkspaceAction(message))) return
			await finishBrowserRecording({ skipEmptyConfirmation: true })
			if (session.stage === 'recording') return
		} else if (!(await confirmWorkspaceAction('Close this flow?'))) {
			return
		}
		if (!currentFlow && activeFlowKey) {
			try {
				// A new taskflow is only a draft until Save; discard every recording
				// persisted under its temporary generated code when the drawer closes.
				await F.tasks.remove(activeFlowKey)
				recordingSessions.delete(activeFlowKey)
				profileDrafts.delete(activeFlowKey)
			} catch (err) {
				console.error('[bridge] 未保存 Taskflow 清理失败：', err)
				alert('Could not discard this unsaved flow: ' + err.message)
				return
			}
		}
		hideNativeBrowser()
		boundsObserver?.disconnect()
		boundsObserver = null
		await _origCloseDrawer()
	}
	$('close').onclick = () => closeDrawer()

	/* ================================================================
	 * 9. 窗口大小变化时重新上报 bounds
	 * ================================================================ */
	window.addEventListener('resize', () => {
		if (boundsObserver) reportBrowserBounds()
	})

	/* ================================================================
	 * 10. 渲染后强制重报 bounds（AI 面板开合等布局变化兜底）
	 *
	 * 浏览器原生视图的位置完全来自上次上报的 #browserFrames 矩形。
	 * 布局变化（如关闭 AI 面板后 drawer 收回 padding）理论上会被
	 * ResizeObserver 捕获，但存在收不到回调的边缘情形，导致浏览器
	 * 一直停在窄宽度、不占据剩余空间。这里在每次工作区渲染后用
	 * RAF + 延迟双保险强制重新测量上报（reportBrowserBounds 自带
	 * 矩形缓存去重，重复调用无副作用）。
	 * ================================================================ */
	const refreshBoundsAfterPaint = () => {
		requestAnimationFrame(() => reportBrowserBounds())
		setTimeout(() => reportBrowserBounds(), 350)
	}
	for (const name of ['renderAIPanel', 'renderSummaryWorkspace', 'renderRecordingWorkspace']) {
		const original = window[name]
		if (typeof original !== 'function') continue
		window[name] = function () {
			const out = original.apply(this, arguments)
			refreshBoundsAfterPaint()
			return out
		}
	}

	/* ================================================================
	 * 启动：加载任务列表
	 * ================================================================ */
	loadTasksFromStore()
})()
