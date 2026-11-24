# Recording Specification

## Purpose

把用户在嵌入式浏览器中的交互录制为经过校验的 Flow 与证据：事件合并、元素事实、导航/标签页/认证分类、系统识别、参数业务命名、rrweb 影像、步骤整页截图与 FlowForge sidecar。会话的容错与可观测性也属于本能力。

## Requirements

### Requirement: The recorder SHALL coalesce raw events into high-level actions after a quiet interval

The recorder SHALL coalesce buffered browser events into one high-level action per user intent after the configured quiet interval.

输入后接 change/blur 合为一个意图；同标签页 5 秒配对窗口内可信的 dragStart+drop 合并为一个 `drag` 步骤（携带 source/target ElementRef，跨 flush 窗口也能配对），任一端无法复核时跳过该步骤并告警；未配对、跨标签页、过期或被中断的拖拽仅保留证据，v1 不为拖拽推断期望。批处理失败在序列化 flush 链内重试一次，仍失败则原始事件留在证据流中并以事件 ID 告警。

#### Scenario: 拖拽配对
- **WHEN** 用户在同一标签页 5 秒内完成一次可信拖放
- **THEN** 生成一个 drag 步骤，两端均解析为 ElementRef

#### Scenario: 批处理重试
- **WHEN** 一个事件批次的处理失败
- **THEN** 在 flush 链内重试一次；再失败则事件保留在证据流，告警点名事件 ID

### Requirement: Element facts SHALL be recollected per capture UID with validated candidates and fingerprints

The recorder SHALL recollect stable element facts per capture UID and validate the derived candidates and fingerprints.

候选唯一性采用「可见元素中唯一」规则：隐藏副本（模板、堆叠通知）不计入。`ariaSnapshot` 无法提供角色/名称时回填近似值（标签→隐式角色、自身文本→名称）。指纹排除框架内部属性（`data-bind`、`data-reactid`、`data-v-*`、`ng-*`）与含换行的值。存活候选全部为结构型（无 testid/role/label/text，仅 css-path/xpath）的步骤写入 `reviewRequired`/`reviewReason`，标记也流入 AI 细化投影。

#### Scenario: 语义候选存活
- **WHEN** 一个 text 候选同时匹配可见按钮与隐藏模板副本
- **THEN** 隐藏副本不影响唯一性判定，语义候选保留

#### Scenario: 脆弱步骤标记
- **WHEN** 某步骤的存活候选只剩结构型选择器
- **THEN** 步骤在录制期即带 reviewRequired/reviewReason 落盘

### Requirement: Host events SHALL merge with page events into tab and navigation steps

The planner SHALL merge host events with page events by timestamp to emit tab and navigation steps.

主进程在会话期间提供 host 事件缓冲（地址栏导航、前进/后退/刷新、原生标签页创建/激活/关闭、观察到的重定向）。新原生标签页生成 `openTab`（首个同标签页导航并入其 URL），显式激活或后续活动记录 `switchTab`；地址栏显式导航记为用户导航；录制前已存在的页面是种子上下文而非隐式新标签页；无可观察原因的导航以 `unknown_navigation` 保留证据而非猜测。

#### Scenario: 新标签页首导航合并
- **WHEN** 录制中打开新标签页并发生首次导航
- **THEN** 生成一个 openTab 步骤携带目标 URL，回放可一次重建标签页与目的地

#### Scenario: 未知原因导航
- **WHEN** 导航无法归因
- **THEN** 以 unknown_navigation 类型保留在证据流

### Requirement: Auth-shaped redirects SHALL be classified config-free as optional navigate steps

Auth-shaped redirects SHALL be classified by built-in IdP host/login-path patterns into standalone `navigate` steps flagged `isOptional`, with no configuration file.

认证形重定向（`sso_redirect`/`login_redirect`/`auto_redirect`）的匹配器编译进代码；同一套匹配器被 sidecar 写入端复用，Flow 与归档不会不一致。此类重定向保留在原始证据流并排除出合并器（不折叠进前一动作的 expectUrl），由回放期解析（见 replay-execution）。

#### Scenario: SSO 跳转录制
- **WHEN** 录制中发生 IdP 登录跳转
- **THEN** 生成 isOptional 的 navigate 步骤，证据流与 FlowForge sidecar 均保留该事件及其类型

### Requirement: System identity SHALL be resolved from URLs by the shared resolver

System identity SHALL be resolved from page URLs by the shared resolver and stamped on steps, raw events, tabs, and the sidecar `systems[]` list.

可选的程序化别名（大小写不敏感的精确主机名匹配）可把同一逻辑系统的多个主机名合并为单一身份并合并其域；桌面端不配置别名，各主机保持裸主机名身份。

#### Scenario: 主机名身份
- **WHEN** 页面 URL 为 `https://erp.corp.local/…`
- **THEN** 步骤与事件标记 systemId 为 `erp.corp.local`

### Requirement: Stopping the recorder SHALL flush pending actions and persist or cancel cleanly

Stopping the recorder SHALL flush pending coalesced actions and either persist a validated Flow with its FlowForge sidecar or cancel cleanly.

空录制抛 `EmptyRecordingError`，主进程按干净取消处理、不持久化录制；启动期等待导航或 CDP 附着时停止会中止启动并丢弃临时输出；空 Stop 让渲染层立即退出、清理在后台进行。sidecar（`flowforge-recording.json`）记录全局有序事件流、稳定事件 ID、标签页/系统身份、前后 DOM 签名、定位证据与 `flowStepId` 回链；输入值与剪贴板文本永不写入。

#### Scenario: 空录制取消
- **WHEN** 用户停止一个未捕获任何步骤的录制
- **THEN** 不产生录制记录，界面按取消收尾

#### Scenario: sidecar 隐私
- **WHEN** 录制包含文本输入并停止
- **THEN** sidecar 不含输入值与剪贴板文本；可执行 Flow IR 仍是回放唯一真源，sidecar 永不被执行

### Requirement: Recording sessions SHALL capture a replayable rrweb stream

Recording sessions SHALL stream a replayable rrweb capture per tab to disk as events happen, instead of taking periodic screenshots.

旧 800ms `capturePage` 周期截图管线与渲染层 webm 合成已删除；列表缩略图来自启动后单张 poster 截图；元素 crop 与步骤整页截图均经单帧 CDP screencast 非破坏性采集（见下两条 requirement），不再有周期性整页截图。快照做瘦身（注释、空白、不可见 head 元数据剔除，可见 DOM 不变）以降低重页面 CPU 峰值。回放呈现见 renderer-ui 的 Record 页签。

#### Scenario: 录制不闪屏
- **WHEN** 录制进行中
- **THEN** 无周期性截图造成的页面闪烁与丢点击

### Requirement: Recording sessions SHALL be instrumented and page-fault tolerant

Recording sessions SHALL tolerate page faults and end with exactly one instrumentation summary.

每个会话输出一条 `[perf] recording-session` 汇总（收到事件数、批次失败、重试后丢弃或重排队、采集重注入尝试、未捕获弹窗、附着/分离页数），稳定性工作从计数开始而非猜测。崩溃或关闭的标签页被移出步骤规划并告警，会话在剩余标签页继续，死页上的动作被跳过而不是抛进 flush 链；弹窗标签页的采集安装有界重试（5 次）并在未捕获时上报。

#### Scenario: 页面崩溃
- **WHEN** 录制中某标签页崩溃
- **THEN** 该页动作被跳过并告警，会话继续，停止时 Flow 正常落盘

### Requirement: Recording sessions SHALL capture full-page step screenshots non-disruptively

录制会话 SHALL 为每个动作步骤采集一张整页截图，采集机制 SHALL 不干扰页面呈现与用户输入（CDP screencast 单帧，与元素裁剪同机制）；截图写入录制产物的 `record/screenshots/` 目录并按步骤序号命名，停止时随录制元数据（`stepScreenshots`）暴露。环境开关 SHALL 能整体跳过步骤截图采集（诊断用途，跳过时截图缺省且录制流程不受影响）。

#### Scenario: 步骤截图产出
- **WHEN** 一次录制包含 5 个动作步骤并正常停止
- **THEN** 产物目录含 5 张按步骤序号命名的整页截图，且录制元数据 stepScreenshots 指向它们

#### Scenario: 采集不干扰操作
- **WHEN** 录制期间用户连续点击与输入
- **THEN** 页面无截图引起的闪烁，用户操作全部生效

#### Scenario: 诊断开关跳过采集
- **WHEN** 以步骤截图禁用开关启动录制
- **THEN** 录制正常完成，产物无步骤截图且 UI 呈现相应空态

### Requirement: Recorded parameters SHALL be extracted as Reference objects with business labels

录制端抽取的参数对象（导航地址 `url_N`、文本输入 `input_N`、下拉取值 `select_N`、上传占位 `file_N`、密码 `password`）SHALL 在保持机器键与模板语义不变的同时，逐个携带业务 label 与 locator 来源定位描述：label 优先取元素关联 label 文本，其次 placeholder、aria-label、name 属性；无文本证据时按输入类型给语义化名称（日期、数字、文本输入等）；同屏成对的日期输入（如开始/结束区间）在共同基础名后缀「-开始」「-结束」；同名冲突追加序号。locator 依同一证据以「页面 · 控件」形式产出（页面取系统名/页面标题或 URL 路径，控件取 label/placeholder/角色）。任何兜底命名都使用业务化措辞，不得把机器键风格名（`input_1` 等）暴露为显示名。

#### Scenario: 成对日期命名
- **WHEN** 录制中用户在同一页面先后填写「创建日期」区间的开始与结束两个日期框
- **THEN** 两个对象的 label 分别为「创建日期-开始」与「创建日期-结束」

#### Scenario: 语义化兜底
- **WHEN** 某文本输入框没有任何 label/placeholder/aria 证据
- **THEN** 该对象获得按输入类型合成的中文业务名（含去重序号），而非机器键风格名

#### Scenario: locator 产出
- **WHEN** 录制端抽取一个输入参数
- **THEN** 该对象同时携带 locator 来源定位描述（页面 · 控件），可被后续编辑
