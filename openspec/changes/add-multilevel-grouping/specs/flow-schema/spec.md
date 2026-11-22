# Spec Delta

## MODIFIED Requirements

### Requirement: The Flow IR SHALL cover the full step family and schema v2 control flow

The Flow IR SHALL cover the full recorded step family, schema v2 control flow, and provenance fields.

步骤族覆盖导航、点击、输入、选择、按键、悬停、滚动、拖拽、上传、等待、断言、条件、抽取、脚本、对话框、标签页开/关/切换与分组。v2 增加条件分支（断言 + 可选分支目标，目标必须是已存在分组或其内步骤——嵌套任意深度均合法，见「Nested group levels」requirement）、`settle` 对象、`timeout` 字段，以及来源字段 `meta.sourceFlows[]`（AI 合并的直接来源链）与 `step.sourceFlowId`（按元素库来源推断的启发式标注，仅用于图形分段，不影响执行）。

#### Scenario: 悬空分支引用被拒绝
- **WHEN** 条件步骤的分支目标指向不存在或空的分组/步骤
- **THEN** 契约校验失败，Flow 不落盘

#### Scenario: 来源字段参与持久化
- **WHEN** 保存一个 AI 合并生成的 Flow
- **THEN** `meta.sourceFlows` 与各步 `sourceFlowId` 被保留（字段已在 schema 声明，Zod 不会剥离）

## ADDED Requirements

### Requirement: Nested group levels SHALL be a first-class validated structure

Nested groups SHALL be validated and persisted as a first-class structure with unbounded depth, where L1 business groups contain L2 technical groups containing L3 steps.

嵌套分组（group 内含 group，任意深度）经契约校验接受并原样持久化；组 id 与步骤 id 共享命名空间且在整个 Flow 内唯一（重复 id 校验拒绝，不再仅防御性取首现）；空分组被拒绝；条件分支目标在嵌套结构下解析为 Flow 内唯一的步骤/分组 id（任意嵌套深度），执行游标按扁平化序跳转、循环上限按最外层拥有分组计数（执行行为不变，由永久回归锁定）。旧扁平 Flow（仅顶层分组）仍是合法 v2 数据，无需迁移。

#### Scenario: 嵌套结构落盘
- **WHEN** 保存一个 L1/L2 两层嵌套分组的 Flow
- **THEN** 契约校验通过，嵌套结构原样持久化，加载后层级不变

#### Scenario: 重复 id 被拒绝
- **WHEN** 某嵌套分组内的步骤 id 与 Flow 内其他步骤/分组 id 重复
- **THEN** 契约校验失败，Flow 不落盘

#### Scenario: 扁平数据兼容
- **WHEN** 加载一个仅含顶层分组的旧 Flow
- **THEN** 校验通过、行为不变，无需任何迁移

### Requirement: Groups SHALL carry an optional target system tag

Groups SHALL carry an optional `targetSystem` string tag identifying the target system, with same-string values meaning the same system.

可选字段挂在分组步骤上（嵌套任意层级均可携带），自由文本；同值字符串视为同一目标系统；叶子步骤的有效系统 = 最近祖先分组的标签；字段在 Zod schema 中显式声明（未声明字段会被剥离，不落盘）；无标签为合法数据。标签不影响执行语义。

#### Scenario: 标签持久化
- **WHEN** 保存一个 L1 分组带 targetSystem 标签的 Flow
- **THEN** 标签值原样持久化，加载后可读取

#### Scenario: 无标签合法
- **WHEN** 保存一个全无标签的 Flow
- **THEN** 校验通过，无标签不影响任何现有行为
