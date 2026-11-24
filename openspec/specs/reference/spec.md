# Reference Specification

## Purpose

Reference 对象契约：把录制/Refine 产生的数据对象（参数、上传文件）定义为一等实体——原始类型目录与终端显示映射、业务命名（label）、必填与校验模型（大小写/格式/正负/条件必填/公式）、安全表达式子集语言、活动关联语义与文件持久化边界。

## Requirements

### Requirement: Reference objects SHALL carry raw types with an end-user display mapping

每个 Reference 对象 SHALL 直接持有原始类型，不经过 "Variable" 中间层；类型目录为封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`，每个类型有唯一的终端用户显示名（地址、文本、整数、小数、日期、密钥、Excel、Word、CSV、Markdown、文件）。正负约束不设独立类型，属校验规则。

#### Scenario: 类型显示映射
- **WHEN** 一个对象的类型为 `url`
- **THEN** 界面与导出中该行类型显示为「地址」，不出现 "Variable" 包装或原始枚举值

#### Scenario: 正数不是类型
- **WHEN** 用户需要「正数」约束
- **THEN** 通过在 `integer`/`decimal` 类型上添加正数校验规则表达，类型本身不变化

### Requirement: Reference objects SHALL be named by business labels with machine keys hidden

每个对象 SHALL 同时持有机器键（`url_1` 等模板/回放内部标识）与业务显示名 label（如「地址」「创建日期-开始」）；label 是唯一面向用户的名称，界面、导出与列头只显示 label。label 缺失时由共享启发式按录制证据回填，任何用户可见场合不得回退显示机器键风格命名。

#### Scenario: label 回填
- **WHEN** 加载一个没有任何 label 的旧 Flow
- **THEN** 系统按步骤证据启发式生成业务 label，用户看到的是业务名而非 `input_1`

#### Scenario: 机器键不可见
- **WHEN** 用户浏览 Reference 页、导出文件或查看步骤呈现
- **THEN** 变量以 label 呈现，机器键不出现在用户视野

### Requirement: Reference validation SHALL support case, format, sign, conditional required, and formula

对象的校验模型 SHALL 覆盖：文本大小写（原样/转大写/转小写，注入前应用）、格式（内置预设 email/URL/手机号 + 自定义正则）、正负规则（正/负/非负/非正，适用于整数与小数）、条件必填（表达式为真时该对象必填）、公式（值由表达式求值产生，用户不可手填）。校验求值失败与规则不满足都构成具名违规，可定位到对象与规则。

#### Scenario: 大小写注入
- **WHEN** 某文本对象设置为转大写且用户填入小写值
- **THEN** 回放注入该值前被转换为大写

#### Scenario: 公式对象只读
- **WHEN** 某对象定义了公式
- **THEN** 其值由求值产生，界面呈只读，手填被拒绝

### Requirement: Reference expressions SHALL run in a sandboxed subset without eval

条件必填与公式 SHALL 使用同一套安全表达式子集语言：算术/比较/逻辑运算、日期函数（如 `TODAY()`、`DATEADD()`）、文本函数、按 label 引用同 Flow 其他对象；实现不得使用动态代码执行（eval/new Function），表达式可静态校验并给出可定位错误。对象间引用禁止循环依赖。

#### Scenario: 非法表达式拒绝
- **WHEN** 用户保存一个语法非法的条件表达式
- **THEN** 编辑界面即时报错并拒绝保存，错误定位到表达式位置

#### Scenario: 循环引用拒绝
- **WHEN** 对象 A 的公式引用对象 B、B 的公式又引用 A
- **THEN** 校验报告循环引用并拒绝该定义

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

### Requirement: Preset validation editing SHALL round-trip the canonical validation structure

业务预设编辑 SHALL 与既有 validation 结构双向兼容：通过预设控件（大小写/格式/正负/日期自动计算/句子式条件必填）保存的规则落盘为同一 validation 结构，行为与高级区直接书写表达式等价；反向，无法映射回任何预设的结构在默认视图标记为「自定义规则」，仅在高级区可编辑。校验规则的业务短句摘要（表格列、违规文案共用）与规则一一对应且为中文业务措辞，不出现枚举值与表达式语法。

#### Scenario: 预设往返
- **WHEN** 用户经预设选择「自动计算：今天+7 天」并保存后重新打开编辑器
- **THEN** 预设控件还原为「自动计算：今天 + 7 天」，落盘结构等价于 DATEADD(TODAY(), 7, "day")

#### Scenario: 自定义规则标记
- **WHEN** 某对象的公式是手写表达式且不匹配任何预设
- **THEN** 默认视图显示「自定义规则」，展开高级区才呈现原始表达式

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
