/**
 * FlowLink IPC Bridge —— 注入到 FlowLink.html 末尾，把 mock 逻辑替换为真实引擎调用。
 *
 * 覆盖范围：
 *  1. 数据层：flowData / saveProfile → IPC TaskStore
 *  2. 浏览器：iframe mock → WebContentsView 定位上报 + IPC 导航
 *  3. 录制：postMessage mock → IPC recordOnPage（步骤流式推送）
 *  4. 分析：referenceOperation mock → 真实 Flow 步骤
 *  5. 列表 Run/Delete：启用并接线 IPC
 */
;(function () {
	const F = window.flowlink
	if (!F) {
		console.error('[bridge] window.flowlink 不可用——preload 未加载？')
		return
	}

	/* ================================================================
	 * 1. 数据层：用 IPC 加载任务，替换 mock flowData
	 * ================================================================ */

	/** 空任务骨架（新建时用） */
	function emptyTask(code) {
		return {
			code,
			name: '',
			description: '',
			version: 'r1',
			status: 'Ready',
			category: '',
			enabled: false,
			versions: [{ name: 'V1', enabled: false }],
			serviceLines: ['', '', '', ''],
			recordings: [],
		}
	}

	/** 从 IPC 加载任务列表并刷新渲染 */
	async function loadTasksFromStore() {
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
					recordings: t.recordings || [],
				})
				const session = recordingSessions.get(t.code)
				if (session && Array.isArray(t.recordings)) {
					for (const recording of t.recordings) {
						if (session.items.some((item) => item.id === recording.id)) continue
						session.items.push({
							id: recording.id,
							name: recording.name || recording.id,
							analyzed: true,
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
								screenshots: (recording.stepScreenshots || recording.frames || []).map((filePath, index) => ({
								image: `file:///${String(filePath).replace(/\\/g, '/')}`,
								name: `Step-${String(index + 1).padStart(2, '0')}.png`,
							})),
								posterFile: recording.posterFile || '',
							},
						})
					}
				}
			}
			for (const session of recordingSessions.values()) {
				for (const item of session.items) {
					if (!item.recordingId || !item.flowFile || item.testFlowSteps?.length) continue
					try {
						const flow = await F.flow.load(item.flowFile)
						item.testFlowSteps = flatFlowSteps(flow?.steps || [])
						item.steps = item.testFlowSteps.map((step) => {
							const kind = step.kind || 'action'
							const value = step.url || step.text || step.value || ''
							return value ? `${kind} · ${String(value).replace(/^(?:https?:\/\/)/, '')}` : kind
						})
						const stepCount = item.steps.length
						item.media.screenshots = item.media.screenshots.slice(0, stepCount)
						while (item.media.screenshots.length < stepCount) {
							item.media.screenshots.push({
								image: '',
								name: `Step-${String(item.media.screenshots.length + 1).padStart(2, '0')}.png`,
							})
						}
						item.testResults = item.testFlowSteps.map(() => ({ status: 'pending' }))
					} catch {}
				}
			}
			render()
		} catch (err) {
			console.error('[bridge] 加载任务失败：', err)
		}
	}

	/* ================================================================
	 * 2. saveProfile → IPC
	 * ================================================================ */
	saveProfile = function () {
		if (!validateProfileServices()) return
		const draft = profileDraft()
		const code = currentFlow?.code || nextTaskflowCode()
		const patch = {
			code,
			name: $('flowName').value.trim(),
			description: $('flowDescription').value.trim(),
			serviceLines: [...draft.serviceLines],
			versions: draft.versions.map((v) => ({ ...v })),
			enabled: draft.versions.some((v) => v.enabled),
			version: currentFlow?.version || 'r1',
			category: currentFlow?.category || '',
			status: currentFlow?.status || 'Ready',
		}
		F.tasks
			.saveProfile(patch)
			.then((task) => {
				if (currentFlow) {
					Object.assign(currentFlow, patch, { recordings: task.recordings || [] })
				} else {
					currentFlow = { ...emptyTask(code), ...patch, recordings: task.recordings || [] }
					flowData.push(currentFlow)
					profileDrafts.set(code, draft)
					profileDrafts.delete('new')
					activeFlowKey = code
				}
				$('drawerTitle').textContent = code.replace('TASKFLOW', 'Taskflow')
				draft.name = patch.name
				draft.description = patch.description
				render()
				$('profileSaveStatus').textContent = 'Saved.'
			})
			.catch((err) => {
				console.error('[bridge] 保存 Profile 失败：', err)
				$('profileSaveStatus').textContent = 'Save failed: ' + err.message
			})
	}

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
	let lastBrowserSurfaceWasTest = false
	mountBrowserSurface = function () {
		const state = recordingSession()
		if (state.browserTabs[0] && !state.browserTabs[0].nativeId)
			state.browserTabs[0].nativeId = 'browser'
		const layout = state.workspaceElement
		const browser = state.browserElement || createBrowserSurface(state)
		const testSlot = layout?.querySelector('.test-tab-browser-slot')
		const isTestMode = Boolean(layout?.classList.contains('is-test') && testSlot)
		const browserParent = isTestMode ? testSlot : layout
		const enteringTestMode = isTestMode && !lastBrowserSurfaceWasTest
		lastBrowserSurfaceWasTest = isTestMode
		if (enteringTestMode && typeof resetTestBrowser === 'function') {
			void resetTestBrowser(currentAssistantItem())
		}
		if (browser.parentElement !== browserParent) {
			browserParent.appendChild(browser)
		}
		browser.hidden = false
		/* 不创建 iframe —— #browserFrames 区域由 WebContentsView 覆盖 */
		const frames = $('browserFrames')
		if (frames) frames.innerHTML = ''

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

	/** 把 #browserFrames 的屏幕矩形上报给主进程 */
	function reportBrowserBounds() {
		const frames = $('browserFrames')
		if (!frames) {
			F.browser.hide()
			return
		}
		const rect = frames.getBoundingClientRect()
		if (rect.width < 2 || rect.height < 2) {
			F.browser.hide()
			return
		}
		const state = recordingSession()
		const dock = document.querySelector('.ai-dock')
		const reserveDock = state.stage === 'recording' && dock && dock.isConnected && !state.workspaceElement?.classList.contains('is-test')
		const dockWidth = reserveDock ? Math.min(32, Math.max(0, rect.width - 2)) : 0
		const boundsWidth = Math.max(1, Math.round(rect.width - dockWidth))
		const boundsKey = `${Math.round(rect.x)},${Math.round(rect.y)},${boundsWidth},${Math.round(rect.height)}`
		if (boundsKey === lastBrowserBoundsKey) return
		lastBrowserBoundsKey = boundsKey
		F.browser.setBounds({
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: boundsWidth,
			height: Math.round(rect.height),
		})
	}

	/* ================================================================
	 * 4. 录制：IPC engine
	 * ================================================================ */

	/** startBrowserRecording：调 IPC recording:start */
	startBrowserRecording = async function () {
		const state = recordingSession()
		if (state.stage === 'recording') return
		const page = activeBrowserPage()
		const draftUrl = validatedRecordingURL(page.draftURL)
		if (draftUrl && draftUrl !== page.url) {
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
		startRecordingMedia(state)

		/* 启动真实录制 */
		const taskCode = currentFlow?.code || activeFlowKey
		try {
			await F.recording.start({ taskCode, startUrl })
			console.log('[bridge] 录制已启动')
		} catch (err) {
			console.error('[bridge] 录制启动失败：', err)
			state.pending = null
			state.stage = 'ready'
			renderRecordingWorkspace()
		}
	}

	/** finishBrowserRecording：调 IPC recording:stop，获取真实 flow */
	finishBrowserRecording = async function () {
		const state = recordingSession()
		if (state.stage !== 'recording' || !state.pending || state.pending.finishing) return
		const pending = state.pending
		pending.finishing = true
		updateBrowserChrome()
		const mediaResult = await stopRecordingMedia(state)
		pending.media = mediaResult

		try {
			const result = await F.recording.stop()
			if (!result?.recording) {
				const fallbackSteps = (pending.actions || []).map((action) => {
					if (action.type === 'click') return `点击【${action.target || '目标'}】`
					if (action.type === 'input') return `在【${action.target || '输入框'}】中填写：${action.value || ''}`
					if (action.type === 'navigate') return `打开 ${action.url || ''}`
					if (action.type === 'tab-open') return '打开新标签页'
					if (action.type === 'tab-switch') return '切换标签页'
					if (action.type === 'tab-close') return '关闭标签页'
					return action.type || '操作'
				}).filter(Boolean)
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
							finishGroupRecording(state, pending, target)
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
				F.browser.hide()
				renderRecordingWorkspace()
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

			if (Array.isArray(pending.actions)) {
				const hasOpenTab = flowSteps.some((step) => step.kind === 'openTab')
				const hasCloseTab = flowSteps.some((step) => step.kind === 'closeTab')
				const hasSwitchTab = flowSteps.some((step) => step.kind === 'switchTab')
				const tabActions = pending.actions.filter((action) =>
					action?.type === 'tab-open' || action?.type === 'tab-close' || action?.type === 'tab-switch'
				)
				let stepNumber = flowSteps.length
				for (const action of tabActions) {
					const pageIndex = state.browserTabs.findIndex((page) => page.nativeId === action.tabId)
					const index = pageIndex > 0 ? pageIndex : 0
					if (action.type === 'tab-open' && !hasOpenTab) {
						flowSteps.push({ kind: 'openTab', id: `s${++stepNumber}`, url: action.url })
					} else if (action.type === 'tab-switch' && !hasSwitchTab) {
						flowSteps.push({ kind: 'switchTab', id: `s${++stepNumber}`, index })
					} else if (action.type === 'tab-close' && !hasCloseTab) {
						flowSteps.push({ kind: 'closeTab', id: `s${++stepNumber}`, index })
					}
				}
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
			let savedVideoFile = ''
			if (mediaResult.videoDataUrl) {
				try {
					savedVideoFile =
						(await F.recording.saveVideo({
							recordingId: result.recording.id,
							taskCode: currentFlow?.code || activeFlowKey,
							dataUrl: mediaResult.videoDataUrl,
						})) || ''
				} catch (err) {
					console.error('[bridge] 保存录制视频失败：', err)
				}
			}
			const recordedScreenshots = (result.recording.stepScreenshots || result.recording.frames || [])
				.slice(0, flowSteps.length)
				.map((filePath, index) => ({
					image: `file:///${String(filePath).replace(/\\/g, '/')}`,
					name: `Step-${String(index + 1).padStart(2, '0')}.png`,
				}))
			while (recordedScreenshots.length < flowSteps.length) {
				recordedScreenshots.push({
					image: '',
					name: `Step-${String(recordedScreenshots.length + 1).padStart(2, '0')}.png`,
				})
			}
			item.media = {
				videoURL:
					mediaResult.videoURL ||
					(savedVideoFile ? `file:///${savedVideoFile.replace(/\\/g, '/')}` : ''),
				screenshots: recordedScreenshots,
				posterFile: result.recording.posterFile || '',
			}
			item.steps = flowSteps.map(flowStepToText)
			item.stepDetails = flowSteps.map(flowStepToDetail)
			item.processGroups = buildGroupsFromSteps(flowSteps)
			item.analyzed = true
			delete item.finishing

			if (pending.groupId && state.items) {
				const target = state.items.find((entry) => entry.id === pending.reRecordTarget)
				if (target) {
					pending.recordedSteps = flowSteps.map(flowStepToText)
					pending.recordedDetails = flowSteps.map(flowStepToDetail)
					pending.recordedFlowSteps = flowSteps
					if (typeof finishGroupRecording === 'function') {
						pending.media = item.media
						finishGroupRecording(state, pending, target)
						return
					}
				}
			}

			state.items.push(item)
			state.focused = item.id
			state.pending = null
			state.stage = 'done'
			item.resultTab = 'Process'
			state.view = 'analysis'
			state.allExplicit = false
			F.browser.hide()
			state.browserElement.hidden = true
			renderRecordingWorkspace()
		} catch (err) {
			console.error('[bridge] 停止录制失败：', err)
			state.pending = null
			state.stage = 'done'
			renderRecordingWorkspace()
		}
	}

	/** Recording fallback metadata for native tab actions and UI-only actions. */
	captureBrowserAction = function (action) {
		const state = recordingSession()
		if (!action || state.stage !== 'recording' || !state.pending) return
		state.pending.actions ||= []
		state.pending.actions.push(action)
	}

	/** Re-record / add recording before or after a process group.
	 *  Overridden in bridge.js because the original in index.html references the
	 *  local window.flowlink handle (F), which is out of scope there. */
	beginGroupRecording = async function (item, groupId, mode) {
		const state = recordingSession()
		if (state.stage === 'recording') return
		const group = ensureProcessGroups(item).find((g) => g.id === groupId)
		if (!group) return

		const message =
			mode === 'replace'
				? `Re-record node ${group.number}? This will replace its recorded steps.`
				: mode === 'before'
					? 'Add a new recording before this node?'
					: 'Add a new recording after this node?'
		if (!(await confirmWorkspaceAction(message))) return

		state.aiOpen = false
		state.view = 'browser'

		while (state.browserTabs.length > 1) {
			const extra = state.browserTabs[state.browserTabs.length - 1]
			try {
				await F.browser.closeTab(extra.nativeId || extra.id)
			} catch {}
			state.browserTabs.pop()
		}
		if (state.browserTabs[0]) {
			state.activeBrowserTab = state.browserTabs[0].id
			state.browserTabs[0].nativeId ||= 'browser'
			await F.browser.switchTab(state.browserTabs[0].nativeId).catch(() => {})
		}

		const page = activeBrowserPage(state)
		let targetUrl = item.url || recordingTestURL
		if (item.flowFile) {
			try {
				const flow = await F.flow.load(item.flowFile)
				targetUrl = flow?.meta?.env?.startUrl || targetUrl
			} catch {}
		}
		if (!targetUrl || targetUrl === 'about:blank') targetUrl = recordingTestURL

		if (page) {
			page.url = targetUrl
			page.draftURL = targetUrl
			page.history = [targetUrl]
			page.historyIndex = 0
		}
		state.url = targetUrl
		state.route = targetUrl.match(/^local:\/\/procurement\/(suppliers|draft|receipts)$/)?.[1] || ''
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

		await navigateRecordingBrowser(targetUrl)
		await startBrowserRecording()
	}

	/** Reset the browser workspace without deleting completed recordings. */
	resetTestBrowser = async function (item) {
		if (!item?.id) return
		const state = recordingSession()
		if (state.stage === 'recording') {
			await finishBrowserRecording()
		}
		state.pending = null
		state.stage = state.stage === 'recording' ? 'ready' : state.stage
		while (state.browserTabs.length > 1) {
			const extra = state.browserTabs[state.browserTabs.length - 1]
			try {
				await F.browser.closeTab(extra.nativeId || extra.id)
			} catch {}
			state.browserTabs.pop()
		}
		const page = state.browserTabs[0]
		if (!page) return
		page.nativeId ||= 'browser'
		await F.browser.switchTab(page.nativeId).catch(() => {})
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
		try {
			const actualUrl = await F.browser.restart(startUrl)
			page.url = actualUrl || startUrl
			page.draftURL = page.url
			page.history = [page.url]
			page.historyIndex = 0
			state.stage = 'done'
			state.pending = null
			syncBrowserSession(state)
		} catch {}
		updateBrowserChrome()
	}

	resetRecordingForNewSession = async function () {
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
		const state = recordingSession()
		const previousActiveId = state.activeBrowserTab
		const previousPage = activeBrowserPage(state)
		const previousUrl = previousPage?.url

		const page = createBrowserPage(recordingTestURL, false)
		// Add the new page to session state BEFORE creating the native tab so that
		// any asynchronous browser:urlChanged event is routed to the new page rather
		// than accidentally updating the previously active tab.
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
			// Rollback: remove the placeholder page and restore the previous active tab.
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
		captureBrowserAction({ type: 'tab-open', url: page.url, tabId: nativeId })

		// Defensive: ensure the previously active tab keeps its original URL.
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
		captureBrowserAction({ type: 'tab-close', tabId: page.nativeId, url: page.url })
	}

	/** Start a real canvas video recorder fed by native WebContentsView capture frames. */
	startRecordingMedia = function (state) {
		const canvas = document.createElement('canvas')
		canvas.width = 960
		canvas.height = 540
		const ctx = canvas.getContext('2d')
		if (!ctx || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
			state.mediaCapture = { canvas, ctx, chunks: [], screenshots: [], recorder: null, frame: null }
			return
		}
		const chunks = []
		const stream = canvas.captureStream(10)
		const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((value) =>
			MediaRecorder.isTypeSupported(value),
		)
		const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
		recorder.ondataavailable = (event) => {
			if (event.data?.size) chunks.push(event.data)
		}
		recorder.start(500)
		ctx.fillStyle = '#101416'
		ctx.fillRect(0, 0, canvas.width, canvas.height)
		state.mediaCapture = { canvas, ctx, chunks, screenshots: [], recorder, stream, frame: null }
	}
	stopRecordingMedia = async function (state) {
		const media = state.mediaCapture
		if (!media) return { videoURL: '', videoDataUrl: '', screenshots: [] }
		if (!media.recorder || media.recorder.state !== 'recording') {
			media.stream?.getTracks().forEach((track) => track.stop())
			state.mediaCapture = null
			return { videoURL: '', videoDataUrl: '', screenshots: media.screenshots || [] }
		}
		await new Promise((resolve) => {
			media.recorder.onstop = resolve
			media.recorder.stop()
		})
		media.stream?.getTracks().forEach((track) => track.stop())
		state.mediaCapture = null
		const blob = new Blob(media.chunks, { type: media.recorder.mimeType || 'video/webm' })
		if (!blob.size) return { videoURL: '', videoDataUrl: '', screenshots: media.screenshots || [] }
		const videoURL = URL.createObjectURL(blob)
		const videoDataUrl = await new Promise((resolve) => {
			const reader = new FileReader()
			reader.onload = () => resolve(String(reader.result || ''))
			reader.readAsDataURL(blob)
		})
		return { videoURL, videoDataUrl, screenshots: media.screenshots || [] }
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

	/** Group by URL within each tab. Returning to a previous tab/URL can create a new node. */
	function buildGroupsFromSteps(steps) {
		const groups = []
		let current = null
		let currentTab = 0
		const currentUrlByTab = new Map()
		for (let i = 0; i < steps.length; i++) {
			const step = steps[i]
			const tab = step.page?.index ?? 0
			if (step.kind === 'navigate' && step.url) currentUrlByTab.set(tab, step.url)
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

	/* ================================================================
	 * 6. 列表 Run / Delete：启用并接线 IPC
	 * ================================================================ */

	/** 覆盖 rowIcon 的 disabled 参数：Run / Delete 不再禁用 */
	const _origRowIcon = rowIcon
	rowIcon = function (name, code, _disabled = false) {
		/* Run 需要有录制才启用 */
		const task = flowData.find((f) => f.code === code)
		const hasRecordings = task && task.recordings && task.recordings.length > 0
		const disabled = name === 'run' ? !hasRecordings : false
		return _origRowIcon(name, code, disabled)
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
	function flatFlowSteps(steps) {
		const out = []
		const visit = (list) => {
			for (const step of list || []) {
				if (step.kind === 'group') visit(step.steps)
				else out.push(step)
			}
		}
		visit(steps)
		return out
	}

	function findTestItem() {
		const state = recordingSession()
		return state.items.find((item) => item.id === state.focused) || null
	}

	window.runFlowlinkTest = async function (item) {
		if (!item?.recordingId || item.testRunning) return
		const state = recordingSession()
		const code = currentFlow?.code || activeFlowKey
		try {
			const flow = await F.flow.load(item.flowFile)
			item.testFlowSteps = flatFlowSteps(flow?.steps || [])
			item.testResults = item.testFlowSteps.map(() => ({ status: 'pending' }))
			item.testRunning = true
			if (item.testFlowSteps.length) item.testResults[0] = { status: 'running' }
			item.resultTab = 'Test'
			renderSummaryWorkspace()
			await F.playback.run({ taskCode: code, recordingId: item.recordingId })
		} catch (err) {
			item.testRunning = false
			const message = err instanceof Error ? err.message : String(err)
			const runningIndex = item.testResults?.findIndex((result) => result.status === 'running') ?? -1
			if (runningIndex >= 0) item.testResults[runningIndex] = { status: 'fail', error: { message } }
			renderSummaryWorkspace()
		}
	}

	async function runFlow(code) {
		const task = flowData.find((f) => f.code === code)
		if (!task || !task.recordings?.length) return
		openDrawer(code, null)
		showDrawerTab('Design')
		const recording = task.recordings[task.recordings.length - 1]
		try {
			const result = await F.playback.run({ taskCode: code, recordingId: recording.id })
			console.log('[bridge] 回放完成：', result)
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
		const state = recordingSession()
		const page = tabId
			? state.browserTabs.find((item) => item.nativeId === tabId) || activeBrowserPage()
			: activeBrowserPage()
		if (!page.nativeId && tabId) page.nativeId = tabId
		page.url = url
		page.draftURL = url
		syncBrowserSession()
		const addr = $('recordingAddress')
		if (addr) addr.value = url
		if (state.view !== 'analysis') updateBrowserChrome()
	})

	F.on('browser:tabOpened', ({ tabId, url }) => {
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
		state.activeBrowserTab = page.id
		syncBrowserSession()
		updateBrowserChrome()
		captureBrowserAction({ type: 'tab-open', url: String(url || ''), tabId })
	})

	F.on('recording:captureFrame', ({ dataUrl, index, tabId, url }) => {
		const state = recordingSession()
		const media = state.mediaCapture
		if (!media || state.stage !== 'recording' || typeof dataUrl !== 'string') return
		const image = new Image()
		image.onload = () => {
			if (state.mediaCapture !== media || !media.ctx) return
			const scale = Math.min(media.canvas.width / image.width, media.canvas.height / image.height)
			const width = image.width * scale
			const height = image.height * scale
			media.ctx.fillStyle = '#101416'
			media.ctx.fillRect(0, 0, media.canvas.width, media.canvas.height)
			media.ctx.drawImage(image, (media.canvas.width - width) / 2, (media.canvas.height - height) / 2, width, height)
			const page = state.browserTabs.find((item) => item.nativeId === tabId)
			const tabIndex = page
				? Math.max(0, state.browserTabs.findIndex((item) => item.id === page.id))
				: 0
			const activeUrl = url || page?.draftURL || page?.url || 'Browser'
			const label = `Tab ${tabIndex + 1} · ${activeUrl}`
			media.ctx.fillStyle = 'rgba(16, 20, 22, 0.92)'
			media.ctx.fillRect(18, 18, Math.min(media.canvas.width - 36, 680), 44)
			media.ctx.fillStyle = '#ffffff'
			media.ctx.font = '600 20px Segoe UI, Arial'
			media.ctx.fillText(label.length > 78 ? `${label.slice(0, 75)}…` : label, 34, 47, 648)
		}
		image.src = dataUrl
		if (!media.screenshots.some((item) => item.index === index)) {
			media.screenshots.push({
				index,
				image: dataUrl,
				name: `Frame-${String(index).padStart(2, '0')}.png`,
			})
		}
	})

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
		console.log('[bridge] 回放步骤：', r.stepId, r.status, r.ms + 'ms')
		const item = findTestItem()
		if (!item?.testRunning) return
		const results = item.testResults || []
		const runningIndex = results.findIndex((result) => result.status === 'running')
		const resultIndex = runningIndex >= 0 ? runningIndex : results.findIndex((result) => result.status === 'pending')
		if (resultIndex < 0) return
		results[resultIndex] = r.status === 'pass'
			? { status: 'pass' }
			: { status: r.status === 'fail' ? 'fail' : 'pending', error: r.error }
		if (r.status === 'pass' && results[resultIndex + 1]) results[resultIndex + 1] = { status: 'running' }
		if (r.status === 'fail') item.testRunning = false
		if (item.resultTab === 'Test') renderSummaryWorkspace()
	})

	/** 回放完成 */
	F.on('playback:done', (result) => {
		console.log('[bridge] 回放完成：', result.ok ? '成功' : '失败', result.metrics)
		const item = findTestItem()
		if (!item?.testRunning) return
		item.testRunning = false
		for (let index = 0; index < (result.steps || []).length; index++) {
			const step = result.steps[index]
			if (!item.testResults[index]) continue
			item.testResults[index] = step.status === 'pass'
				? { status: 'pass' }
				: step.status === 'fail'
					? { status: 'fail', error: step.error }
					: { status: 'pending' }
		}
		if (item.resultTab === 'Test') renderSummaryWorkspace()
	})

	/** 回放错误 */
	F.on('playback:error', ({ message }) => {
		console.error('[bridge] 回放错误：', message)
		const item = findTestItem()
		if (item?.testRunning) {
			item.testRunning = false
			const index = item.testResults.findIndex((result) => result.status === 'running')
			if (index >= 0) item.testResults[index] = { status: 'fail', error: { message } }
			if (item.resultTab === 'Test') renderSummaryWorkspace()
		}
	})

	/* ================================================================
	 * 8. Drawer 关闭时隐藏内嵌浏览器
	 * ================================================================ */
	const _origCloseDrawer = closeDrawer
	closeDrawer = async function () {
		const session = recordingSession()
		if (session.stage === 'recording') {
			if (!await confirmWorkspaceAction('Stop recording and close?')) return
			await finishBrowserRecording()
		}
		F.browser.hide()
		boundsObserver?.disconnect()
		boundsObserver = null
		await _origCloseDrawer()
	}

	/* ================================================================
	 * 9. 窗口大小变化时重新上报 bounds
	 * ================================================================ */
	window.addEventListener('resize', () => {
		if (boundsObserver) reportBrowserBounds()
	})

	/* ================================================================
	 * 启动：加载任务列表
	 * ================================================================ */
	loadTasksFromStore()
})()
