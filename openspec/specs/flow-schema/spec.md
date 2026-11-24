# Flow Schema Specification

## Purpose

定义 Flow JSON 的权威契约：版本化动作 IR（v3：嵌套分组、Reference 元数据）、Zod 校验、迁移与原子写入。录制、编辑、AI 生成与回放所有路径产生的 Flow 都必须经过本契约；本能力不负责采集或回放本身（见 recording 与 replay-execution）。

## Requirements

### Requirement: The schema SHALL validate every Flow at file and input boundaries

The schema layer SHALL parse and contract-validate every Flow at file and input boundaries; TypeScript types alone MUST NOT be treated as validity.

任何 Flow 在文件读写或跨模块输入边界都必须通过 Zod 解析与契约校验。Zod 在每次保存/加载时剥离未声明字段，因此新增持久化字段必须先在 schema 中声明。

#### Scenario: 拒绝非法 Flow
- **WHEN** 加载一个缺少必需字段或违反契约的 Flow JSON
- **THEN** 解析失败并返回明确错误，而不是静默接受或部分采用

#### Scenario: 剥离未声明字段
- **WHEN** 保存一个携带 schema 未声明字段的 Flow
- **THEN** 未声明字段被剥离，不进入持久化结果

### Requirement: migrateFlow SHALL upgrade old schema versions stepwise without rewriting steps

`migrateFlow()` SHALL migrate old schema versions stepwise, stamping only `schemaVersion` and never rewriting existing steps.

迁移按 v0 → v1 → v2 → v3 逐步进行；迁移后的旧录制保持原有步骤序列与回放行为。v2 → v3 只做 Reference 元数据升级：变量类型按映射改写（`text`→`string`、`email`→`string` 附加 email 格式预设校验、`number`→按默认值含小数点判 `integer`/`decimal`、`date`/`secret`/`file` 保持），缺失的 label 由共享启发式按步骤证据回填，必填/校验/活动关联缺省为空。高于 `SCHEMA_VERSION` 的版本被拒绝而不是降级。

#### Scenario: v1 录制迁移
- **WHEN** 加载 schema v1 的历史录制
- **THEN** 迁移为 v3 版本标记，步骤序列与回放行为不变

#### Scenario: v2 类型映射
- **WHEN** 加载一个含 `email` 类型变量的 schema v2 Flow
- **THEN** 迁移后该变量类型为 `string` 且携带 email 格式预设校验，模板引用与默认值不变

#### Scenario: 拒绝未来版本
- **WHEN** 加载 `schemaVersion` 高于当前 `SCHEMA_VERSION` 的 Flow
- **THEN** 拒绝加载并报错，不尝试降级

### Requirement: observed facts SHALL remain immutable record-time evidence

`observed` facts SHALL remain immutable record-time evidence, kept distinct from mutable resolution data.

`candidates`、`fingerprint`、解析结果与自愈/AI 输出属于可变的 resolution 数据，必须与 observed 保持分离。

#### Scenario: 自愈只改 resolution 数据
- **WHEN** 回放期自愈更新了定位信息
- **THEN** 只有候选/指纹/解析数据变化，observed 证据保持原样

### Requirement: Secret values SHALL be represented by named templates

Secret values SHALL be stored as named template references such as `{{password}}`, never as plaintext in saved action values.

非密钥默认值保存在 `flow.variables`（Reference），密钥变量不持久化默认值。

#### Scenario: 密码保持模板
- **WHEN** 录制包含密码输入并保存 Flow
- **THEN** 动作值保持模板引用，密钥不落盘；回放时由会话内存中的密钥变量注入

### Requirement: The Flow IR SHALL cover the full step family and schema v2 control flow

The Flow IR SHALL cover the full recorded step family, schema v2 control flow, and provenance fields.

步骤族覆盖导航、点击、输入、选择、按键、悬停、滚动、拖拽、上传、等待、断言、条件、抽取、脚本、对话框、标签页开/关/切换与分组。v2 增加条件分支（断言 + 可选分支目标，目标必须是已存在分组或其内步骤——嵌套任意深度均合法，见「Nested group levels」requirement）、`settle` 对象、`timeout` 字段、`execution` 执行方式（`automated`/`manual`，省略 = `automated`，为历史 Flow 的隐式默认），以及来源字段 `meta.sourceFlows[]`（AI 合并的直接来源链）与 `step.sourceFlowId`（按元素库来源推断的启发式标注，仅用于图形分段，不影响执行）。

#### Scenario: 悬空分支引用被拒绝
- **WHEN** 条件步骤的分支目标指向不存在或空的分组/步骤
- **THEN** 契约校验失败，Flow 不落盘

#### Scenario: 来源字段参与持久化
- **WHEN** 保存一个 AI 合并生成的 Flow
- **THEN** `meta.sourceFlows` 与各步 `sourceFlowId` 被保留（字段已在 schema 声明，Zod 不会剥离）

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

### Requirement: Reference metadata SHALL be schema-declared and versioned with the Flow

Reference 对象元数据 SHALL 作为 Flow 的一部分经 Zod 声明并随 Flow 版本落盘：`flow.variables` 条目扩展 `label`（业务显示名）、`type`（新封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`）、`required`、`validation`（大小写/格式预设与正则/正负/条件表达式/公式表达式）、`activities`（L1 分组 id 数组）、`file`（可选附件元数据：文件名 + 相对工件路径，文件类对象专用）；新增 `flow.referenceFiles` 数组持久化上传文件（文件名、类型、相对工件路径）。变量机器键（name）与 `{{name}}` 模板语法保持 ASCII 标识符不变，schema 剥离未声明字段。

#### Scenario: 未声明字段剥离
- **WHEN** 保存一个变量携带 schema 未声明字段的 Flow
- **THEN** 该字段被剥离，不进入持久化结果

#### Scenario: 模板键不变
- **WHEN** 加载并重新保存一个迁移到 v3 的旧 Flow
- **THEN** 步骤值中的 `{{url_1}}` 等模板引用与变量机器键逐字节保持

### Requirement: Relative artifact references SHALL stay inside the artifact root

Relative artifact references SHALL be validated to stay inside the artifact root.

相对 crop 等工件引用不得逃逸出工件根目录。

#### Scenario: 逃逸路径被拒绝
- **WHEN** Flow 携带解析后指向工件根之外的相对路径
- **THEN** 校验失败

### Requirement: Flow writes SHALL be atomic with version bump on modification

Flow writes SHALL be atomic, and modification writes SHALL bump the flow version and keep a `.bak` backup.

`engine/schema/src/io.ts` 负责加载、迁移、校验、序列化与原子写入。

#### Scenario: 编辑写回
- **WHEN** 通过 `flow:updateSteps` / `flow:updateVariables` 保存编辑
- **THEN** Flow 版本递增，旧版本以 `.bak` 保留
