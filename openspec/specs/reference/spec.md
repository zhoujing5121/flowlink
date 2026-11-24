# Reference Specification

## Purpose

Reference 对象契约：把录制/Refine 产生的数据对象（参数、上传文件）定义为一等实体——原始类型目录与终端显示映射、业务命名（label）、必填与校验模型（大小写/格式/正负/条件必填/公式）、安全表达式子集语言、活动关联语义与文件持久化边界。

## Requirements

### Requirement: Reference objects SHALL carry raw types with an end-user display mapping

每个 Reference 对象 SHALL 直接持有原始类型，不经过 "Variable" 中间层；类型目录为封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`，每个类型有唯一的终端用户显示名（网址、文本、整数、小数、日期、密钥、Excel、Word、CSV、Markdown、文件）。正负等取值约束不设独立类型，属规则文本内容。

#### Scenario: 类型显示映射
- **WHEN** 一个对象的类型为 `url`
- **THEN** 界面与导出中该行类型显示为「网址」，不出现 "Variable" 包装或原始枚举值

#### Scenario: 正数不是类型
- **WHEN** 用户需要「正数」约束
- **THEN** 通过在规则文本中描述（类型为整数或小数），类型本身不变化

### Requirement: Reference rules SHALL be free text that the program stores but never parses

每个对象 SHALL 可携带一条自由文本规则（自然语言描述填写/校验要求，如「必须是邮箱格式；提交日期自动填今天」）。程序 SHALL 只存储与展示该文本，不解析、不执行；大小写、格式、正负、条件必填、公式等不再有程序侧行为。AI refine SHALL 依页面证据为变量建议规则文本（`variableRules`：机器键必须已存在、未知键整次拒绝、非空建议覆盖旧值、确认界面可改）；回放期由 AI 理解与执行规则属后续能力。程序侧唯一保留的强制行为是 Mandatory：必填对象缺失时回放启动被拦截。

#### Scenario: 规则只存不解析
- **WHEN** 用户在规则框输入任意自然语言文本并保存
- **THEN** 文本原样持久化并在下次打开时还原，程序不做任何解析或报错

#### Scenario: AI 规则建议
- **WHEN** refine 输出为某变量建议规则「必须是 11 位手机号」
- **THEN** 确认界面呈现该建议文本供用户修改，接受后写入该对象的规则字段

#### Scenario: 未知机器键拒绝
- **WHEN** 模型 variableRules 表中出现源 Flow 不存在的变量机器键
- **THEN** 生成被拒绝并点名该键，不产出半成品 Flow

### Requirement: Reference objects SHALL carry a locator describing their source

每个对象 SHALL 携带 locator 来源定位描述（该对象从哪个页面的哪个控件拍取，如「订单列表 · 筛选面板『创建日期』输入框」）：录制端依证据自动产出（系统/页面与控件证据），迁移对旧 Flow 按步骤证据回填，用户可编辑；Locator 列在 Reference 表格 Type 之后展示。AI 不改写 locator。

#### Scenario: 录制自动产出
- **WHEN** 录制中用户在某页面填写一个输入框
- **THEN** 对应对象携带「页面 · 控件」形式的来源定位描述

#### Scenario: 迁移回填
- **WHEN** 加载一个 v3 Flow（变量无 locator）
- **THEN** 迁移后对象获得按步骤证据回填的来源定位描述

### Requirement: Reference objects SHALL be named by business labels with machine keys hidden

每个对象 SHALL 同时持有机器键（`url_1` 等模板/回放内部标识）与业务显示名 label（如「地址」「创建日期-开始」）；label 是唯一面向用户的名称，界面、导出与列头只显示 label。label 缺失时由共享启发式按录制证据回填，任何用户可见场合不得回退显示机器键风格命名。

#### Scenario: label 回填
- **WHEN** 加载一个没有任何 label 的旧 Flow
- **THEN** 系统按步骤证据启发式生成业务 label，用户看到的是业务名而非 `input_1`

#### Scenario: 机器键不可见
- **WHEN** 用户浏览 Reference 页、导出文件或查看步骤呈现
- **THEN** 变量以 label 呈现，机器键不出现在用户视野

### Requirement: Reference objects SHALL link to L1 activities with a whole-recording default

每个对象 SHALL 可多选关联活动（Refine 后 Flow 的顶层业务分组）；未 Refine 的原始录制只有一个隐含活动（整段录制，名称为录制名），对象默认全部关联它。多个对象可关联同一活动，一个对象可关联多个活动。关联随 Flow 版本落盘；Refine 产出的新材料对应新分组结构，不跨版本迁移旧关联。

#### Scenario: 原始录制默认整段
- **WHEN** 查看一个未 Refine 录制的 Reference 页
- **THEN** 所有对象的活动列显示该录制整段这一个活动

#### Scenario: Refine 后重选
- **WHEN** 一份 Refine 后的 Flow 顶层有 3 个业务分组
- **THEN** 对象的活动列可在 3 个分组中多选，可多个对象指向同一分组

### Requirement: Uploaded Reference files SHALL persist inside the recording artifact root

上传的 Reference 文件（.xlsx/.xls/.csv/.md/.docx）SHALL 拷贝进该录制工件目录的 `references/` 子目录，元数据（文件名、类型、相对路径）随 Flow 落盘；应用重启后文件行仍在且可再下载。解析后的文件路径必须保持在工件根之内，逃逸路径被拒绝；删除录制时随既有级联清理一并移除。

#### Scenario: 重启不丢
- **WHEN** 用户上传一个 .docx 后重启应用再打开该录制的 Reference 页
- **THEN** 该文件行仍在，可再次下载，内容与上传时一致

#### Scenario: 路径逃逸拒绝
- **WHEN** Reference 文件元数据携带指向工件根之外的路径
- **THEN** 校验失败，该文件不被接受

### Requirement: Refined materials SHALL default variable activities from usage evidence

Refine 产出的新材料，变量活动关联 SHALL 具备默认值：优先按使用证据推导——变量模板出现在哪些 L1 分组的步骤中即默认关联哪些分组（多处分组即多选）；无使用证据的变量采用模型 variableActivities 建议（钳制到真实存在的分组 id）；证据与建议冲突时以证据为准。落盘时清除自源 Flow 继承的过期分组 id，不残留悬空关联。

#### Scenario: 使用证据推导
- **WHEN** 某变量被新材料两个不同 L1 分组的步骤引用
- **THEN** 该对象默认关联这两个分组，用户可增删

#### Scenario: AI 建议填充
- **WHEN** 某变量未被任何步骤引用且模型建议关联分组「提交订单」
- **THEN** 该对象默认关联「提交订单」（id 真实存在时），否则不关联

### Requirement: File-typed objects SHALL carry a persisted attachment

类型为 `excel`/`word`/`csv`/`md`/`file` 的对象 SHALL 可携带一个持久化附件：文件存于该录制工件的 `references/` 目录且路径不得逃逸工件根；对象值显示附件文件名；覆盖上传替换旧文件；删除移除附件元数据与文件；回放启动时附件解析为工件内绝对路径注入该对象的值，upload 步骤直接可用。

#### Scenario: 上传保存显示文件名
- **WHEN** 用户为某文件类对象上传附件并保存
- **THEN** 值列显示文件名，文件持久化于 references/ 目录，重启后仍在

#### Scenario: 回放路径注入
- **WHEN** 回放启动且某文件类对象携带附件
- **THEN** 该对象注入的值为附件在工件内的绝对路径

#### Scenario: 覆盖与删除
- **WHEN** 用户覆盖上传新文件或点击删除按钮并保存
- **THEN** 旧文件被新文件替换或附件与文件一并移除，值列相应更新
