# Spec Delta

## MODIFIED Requirements

### Requirement: Reference objects SHALL carry raw types with an end-user display mapping

每个 Reference 对象 SHALL 直接持有原始类型，不经过 "Variable" 中间层；类型目录为封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`，每个类型有唯一的终端用户显示名（网址、文本、整数、小数、日期、密钥、Excel、Word、CSV、Markdown、文件）。正负等取值约束不设独立类型，属规则文本内容。

#### Scenario: 类型显示映射
- **WHEN** 一个对象的类型为 `url`
- **THEN** 界面与导出中该行类型显示为「网址」，不出现 "Variable" 包装或原始枚举值

#### Scenario: 正数不是类型
- **WHEN** 用户需要「正数」约束
- **THEN** 通过在规则文本中描述（类型为整数或小数），类型本身不变化

## REMOVED Requirements

### Requirement: Reference validation SHALL support case, format, sign, conditional required, and formula
**Reason**: 产品方向变更——校验规则由 AI 理解和执行，程序不再解析结构化校验（用户 2026-11-24 决策）。
**Migration**: 存量结构化规则在 schema v3→v4 迁移中经 describe 语义转换为中文句子写入自由文本 `rules` 字段；大小写转换、公式求值、格式拦截等程序侧行为随本 change 移除。

### Requirement: Reference expressions SHALL run in a sandboxed subset without eval
**Reason**: 同上——表达式语言无存在必要。
**Migration**: 无运行时等价物；相关代码与测试删除。

### Requirement: Preset validation editing SHALL round-trip the canonical validation structure
**Reason**: 编辑界面统一改为单个自由文本规则输入框，预设与高级区不再存在。
**Migration**: 无；旧结构化数据经迁移转文本。

## ADDED Requirements

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
