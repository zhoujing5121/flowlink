/**
 * Recorder 内部数据类型 —— 只在「采集 → 合流 → 推断 → 生成 IR」之间传递，**不进 IR**。
 * IR 类型（Flow/Step/ElementRef/...）的唯一真源是 `@rr/schema`。
 *
 * 这些接口描述录制器的瞬时通信协议，不是另一套序列化契约。Node 侧可以补充浏览器原始事实，
 * 但复制进 Flow 的只能是 schema 管理的对象；尤其不能把标为 Node 侧补充的数据当成 observed 证据。
 */
import type { Candidate, Crop, ElementRef, Flow, FramePath, Rect, Step } from '../../schema/src/index.js'
import type { Page } from 'playwright-core'

/* ------------------------------------------------------------------ */
/* 页面内采集的原始事实                                                  */
/* ------------------------------------------------------------------ */

/**
 * 页面内 `__rrFacts()` 采到的原始事实。
 *
 * 设计原则：**页面内只采事实，不做语义判断**。role / accessibleName / candidates
 * 一律在 Node 侧补（用 Playwright 自己的 ariaSnapshot 与 locator 校验），
 * 避免录放两端各有一套可访问性算法而漂移。
 */
export interface RawElementFacts {
	/**
	 * 采集时打在元素上的临时标记（`data-rr-uid`），只用于 Node 侧把它找回来校验候选，
	 * **不写进 IR**，处理完会清掉。
	 */
	uid?: string
	tag: string
	/** 元素 class（截断 200 字；Node 侧筛掉动态 token 后才用于生成 css 候选） */
	className?: string
	/** 属性白名单（不含 class/style/data-rr-uid、不含 value 等可能含隐私的值） */
	attributes: Record<string, string>
	/** 元素可见文本（已折叠空白、截断 200 字） */
	text?: string
	/** 相对 viewport 的 CSS 像素矩形 */
	rect: Rect
	/** 采集时所在 frame 的页面滚动位置 */
	scroll: { x: number; y: number }
	viewport: { width: number; height: number }
	dpr: number
	recordedAt: number
	/** 关联 label 文本（原生 .labels + aria-label + aria-labelledby） */
	labels?: string[]
	/** 邻近文本锚点（左/上/父容器内的文本片段） */
	nearbyText?: string[]
	/** 从 documentElement 到元素的 children 索引链 */
	nodePath?: number[]

	/* ---------- 以下由 Node 侧补充（不进 ObservedFacts） ---------- */
	/** Node 侧用 ariaSnapshot 拿到的真实 role */
	role?: string
	/** Node 侧用 ariaSnapshot 拿到的 accessible name */
	accessibleName?: string
	/** Node 侧校验通过的候选（已按 score 升序）；缺省时由 facts 推导 */
	candidates?: Candidate[]
	/** 候选校验结论，用于 description / 已知限制标注 */
	validation?: 'ok' | 'detached' | 'ambiguous' | 'unvalidated'
	/**
	 * 目标位于 shadow 树内（Spike A 结论）：
	 * closed 时 Playwright / aria 都进不去，回放只能 host + innerOffset 兜底。
	 */
	shadowRootType?: 'open' | 'closed'
	/** closed shadow 内层元素相对 host padding box 的 CSS px 偏移（取自事件坐标，不乘 dpr） */
	innerOffset?: { x: number; y: number }
	/** iframe 链锚点（Node 侧补） */
	frame?: FramePath
	/** 元素裁剪图引用（Node 侧补） */
	crop?: Crop
}

/* ------------------------------------------------------------------ */
/* 原始事件                                                             */
/* ------------------------------------------------------------------ */

export type RawEventKind =
	| 'click'
	| 'pointerdown'
	| 'contextmenu'
	| 'keydown'
	| 'input'
	| 'change'
	| 'scroll'
	| 'hover'
	| 'navigation'
	| 'dblclick'
	| 'submit'
	| 'dragStart'
	| 'drop'
	| 'copy'
	| 'paste'
	| 'extractValue'
	| 'focus'
	| 'blur'

/** 各事件类型的特有字段（页面 → Node 原样回传） */
export interface RawEventData {
	/** click/pointerdown: 0=左 1=中 2=右 */
	button?: number
	modifiers?: string[]
	key?: string
	code?: string
	/** 单字符且无 Ctrl/Meta/Alt —— 这类 keydown 通常会被 input 事件取代 */
	isPrintable?: boolean
	repeat?: boolean
	isComposing?: boolean
	/** input/change 的当前值；password 时为 undefined（永不采集明文） */
	value?: string
	/** 值被屏蔽（password）—— Node 侧要转成 {{password}} 模板 */
	masked?: boolean
	checked?: boolean
	inputType?: string
	formName?: string
	clipboardContentCaptured?: boolean
	pickedText?: string
	selectedValues?: string[]
	/** scroll 增量（页面内基于上一次滚动位置算好） */
	dx?: number
	dy?: number
	/** hover 停留时长（页面内已验证 ≥350ms 未移出） */
	dwellMs?: number
	/**
	 * 点击点相对「被点元素 padding box」的 CSS px 偏移。
	 * 用途只有一个：closed shadow 目标回放时必须给 host 一个精确的 position。
	 */
	offset?: { x: number; y: number }
}

export interface RawEvent {
	eventId?: string
	kind: RawEventKind
	/** True when the navigation is a distinct action, not merely the result of the previous action. */
	directNavigation?: boolean
	/** Best-effort cause classification; unknown is preferred over inventing user intent. */
	navigationType?: 'initial' | 'user_navigate' | 'user_link' | 'user_redirect' | 'sso_redirect' | 'login_redirect' | 'auto_redirect' | 'popup_navigation' | 'history_navigation' | 'unknown_navigation'
	/** URL before this navigation, when known. */
	previousUrl?: string
	/** Evidence used to classify the navigation. */
	navigationEvidence?: string[]
	/** 发生时间（Date.now()） */
	ts: number
	/** 事件所在 frame 的序号（Node 侧按 Frame 对象分配） */
	frameIndex?: number
	/** 事件来自哪个标签页（Node 侧按 Page 创建顺序分配，0 = 录制起点） */
	pageIndex?: number
	/** Electron native tab identity supplied by the host application. */
	tabId?: string
	systemId?: string
	systemName?: string
	frameUrl?: string
	/** navigation 事件的目标 url */
	url?: string
	facts?: RawElementFacts
	/** Structured DOM-signature evidence around the action, added by the Node recorder. */
	beforeSnapshot?: PageSignature
	afterSnapshot?: PageSignature
	flowStepId?: string
	locatorEvidence?: Candidate[]
	data?: RawEventData
	/**
	 * 事件是否由真实输入（或 CDP 注入的可信输入）产生。
	 * 说明：click/keydown 只收 trusted；input/change 收 untrusted 但也带这个标记 ——
	 * 因为 Playwright 的 `fill()` 是用 JS 赋值 + dispatchEvent 实现的（untrusted），
	 * 而 `drive()` 驱动的录制必须能录到它。页面脚本自造的 click 仍然是噪声，所以只放行值变化类事件。
	 */
	trusted?: boolean
}

/* ------------------------------------------------------------------ */
/* 合流结果                                                             */
/* ------------------------------------------------------------------ */

export type CoalescedActionKind =
	'navigate' | 'click' | 'input' | 'select' | 'key' | 'scroll' | 'hover' | 'drag' | 'unknown'

/** 一个可落成 Step 的动作（500ms 缓冲合流之后） */
export interface CoalescedAction {
	kind: CoalescedActionKind
	/** 动作时间（取合并后最后一条事件的 ts） */
	ts: number
	facts?: RawElementFacts
	/** drag：起点/终点元素事实（其余 kind 只用 facts；drag 必有 from/to） */
	from?: RawElementFacts
	to?: RawElementFacts
	frameIndex?: number
	frameUrl?: string
	/** 在哪个标签页（由 RawEvent 透传；合成 switchTab 时用来决定切页） */
	pageIndex?: number

	/** click */
	button?: 'left' | 'right' | 'middle'
	clickCount?: number
	modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>

	/** input / select */
	value?: string
	selectedValues?: string[]
	/** input 的值被屏蔽（password） */
	masked?: boolean

	/** key（组合键时与 modifiers 一起使用） */
	key?: string

	/** scroll */
	delta?: { x: number; y: number }

	/** click 的坐标兜底（closed shadow / canvas），相对 target padding box 的 CSS px */
	offset?: { x: number; y: number }

	/** navigate */
	url?: string
	navigationType?: RawEvent['navigationType']
	previousUrl?: string
	navigationEvidence?: string[]

	/** 紧随本动作的导航（并入本步 expect） */
	expectUrl?: string

	/** 合并了多少条原始事件（调试用） */
	merged?: number
	/**
	 * 参与合并的原始事件（keepRaw 时落盘）。
	 * 多个 DOM 事件合成一个 Step 时，用此字段保留来源；它不属于 Flow IR，正常录制可省略。
	 */
	raw: RawEvent[]
}

/* ------------------------------------------------------------------ */
/* 页面签名（用于 expect 推断）                                          */
/* ------------------------------------------------------------------ */

export interface SignatureNode {
	/** 跨时间稳定的 key：`<frameIndex>:<tag>#<nodePath>|<text>` */
	key: string
	tag: string
	/** 显式 role 属性（页面内直接读，不跑 accname）—— 只用于挑 expect 目标 */
	role?: string
	/** 该节点属于哪个 frame（0 = 主 frame） */
	frameIndex?: number
	text: string
	/** 快照时的属性白名单（元素消失后重建 ElementRef 用） */
	attributes?: Record<string, string>
	/** 快照时的 children 索引链 */
	nodePath?: number[]
	/** 快照所在页面的视口 / dpr / 滚动位置（同上） */
	viewport?: { width: number; height: number }
	dpr?: number
	scroll?: { x: number; y: number }
	rect: Rect
	uid?: string
	/** 若该节点被选为 expect 目标，record() 会按需填入 */
	ref?: ElementRef
}

export interface PageSignature {
	url: string
	nodes: SignatureNode[]
}

/* ------------------------------------------------------------------ */
/* 录制选项 / 结果（对外契约，见 docs/architecture.md §3）                */
/* ------------------------------------------------------------------ */

export interface RecordOptions {
	startUrl: string
	outPath: string
	/** 默认 1440x900 */
	viewport?: { width: number; height: number }
	/** 默认 false（录制时人工操作） */
	headless?: boolean
	/** 默认 ./artifacts */
	artifactsRoot?: string
	/** 保留原始事件流到 <out>.raw.json（调试用） */
	keepRaw?: boolean
	onStep?: (step: Step) => void
	stopSignal?: AbortSignal
	/**
	 * e2e / 批量录制：程序化驱动页面。
	 * 回调拿到 page，执行动作；回调 resolve 后自动 stop 并落盘（不必手动调 stop）。
	 */
	drive?: (page: Page, stop: () => void) => Promise<void>
	/**
	 * 接到已经打开的 Playwright Page 上录制（Electron 内嵌页 / 已有 context）。
	 * 给了它就不 `chromium.launch()`，结束时也不关浏览器。
	 */
	page?: Page
	/** 显式附加其他 Electron 原生标签页，以支持多标签录制。 */
	pages?: Page[]
	/** Stable Electron tab IDs in the same order as page + pages. */
	tabIds?: string[]
	/** Mutable host event buffer used to capture native tab switches and address-bar navigation. */
	hostEvents?: ReadonlyArray<{
		action: string
		ts: number
		tabId: string
		url?: string
		previousUrl?: string
	}>
	/**
	 * 只往指定 page 注入采集脚本，不在 context 上 addInitScript。
	 * Electron 的 CDP context 会同时包含产品 UI 和内嵌页，必须开这个，否则会录到壳层点击。
	 */
	attachOnly?: boolean
	/** 页面已经停在 startUrl 时跳过 goto（内嵌浏览器由产品自己导航） */
	skipNavigate?: boolean

	/**
	 * 主机名 → 系统名别名：完整主机名精确匹配（大小写不敏感），命中后收敛为同一 systemId。
	 * 编程调用方专用 API（应用侧不提供配置文件，始终使用裸主机名行为）。
	 */
	systemAliases?: Record<string, string>

	/** 事件合流窗口，默认 500ms */
	bufferMs?: number
	/** 动作后静默判定，默认 300ms（配合「连续 2 帧布局不变」） */
	settleSilenceMs?: number
	/** flow 标题，默认取 startUrl 的 pathname */
	title?: string

	/**
	 * 启动 context 前读取的登录态文件（Playwright `storageState` JSON）。
	 * 也接受 Studio 的 profile wrapper（`{origin,savedAt,storageState}`）：
	 * 读失败（不存在/非法 JSON/形状不对）一律当「没有登录态」继续录，不报错。
	 *
	 * 典型用法：Studio 按起始 URL 的 origin 找到 `profiles/<originKey>.json` 后传入。
	 */
	storageStatePath?: string
	/**
	 * 录制停止时把当前 `context.storageState()` 写回该路径（原子写：临时文件 + rename）。
	 * 失败只告警，不影响 flow 落盘；`drive` 抛错时也会保存（用户可能已经登录成功）。
	 */
	saveStorageStatePath?: string
}

export interface RecordResult {
	flow: Flow
	artifactsDir: string
	rawPath?: string
}

/* ------------------------------------------------------------------ */
/* 录制期旁路事件：原生对话框 / 下载                                     */
/* ------------------------------------------------------------------ */

/**
 * 录制期捕获的原生对话框。
 * 录制器会**立刻 accept**（否则页面被 modal 卡住录不下去），同时记一条 dialog 步骤供回放复现。
 */
export interface RecordedDialog {
	ts: number
	pageIndex: number
	action: 'accept' | 'dismiss'
	/** prompt 的默认/输入文案（alert/confirm 无） */
	promptText?: string
}

/** 录制期捕获的下载（用来给触发它的那一步补 `expect: {kind:'download'}`） */
export interface RecordedDownload {
	ts: number
	pageIndex: number
	filename: string
}

/* ------------------------------------------------------------------ */
/* 规划结果：动作 / 合成 switchTab / dialog                              */
/* ------------------------------------------------------------------ */

/**
 * 合流之后、成步之前的一层「规划」。
 * 这一层是**纯函数**（`plan.ts`），负责两件不能靠单条事件决定的事：
 * 1. 标签页切换：动作的 pageIndex 变化时，先在前面插一条合成 `switchTab`；
 * 2. 对话框顺序：dialog 是旁路事件，按时间戳插到「触发它的那一步」之后。
 */
export type PlannedItem =
	| { kind: 'action'; action: CoalescedAction }
	| { kind: 'switchTab'; ts: number; index: number; pageIndex: number }
	| { kind: 'openTab'; ts: number; index: number; pageIndex: number; url?: string }
	| {
			kind: 'dialog'
			ts: number
			pageIndex: number
			action: 'accept' | 'dismiss'
			promptText?: string
	  }
