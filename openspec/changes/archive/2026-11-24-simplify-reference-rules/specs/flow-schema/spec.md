# Spec Delta

## MODIFIED Requirements

### Requirement: migrateFlow SHALL upgrade old schema versions stepwise without rewriting steps

`migrateFlow()` SHALL migrate old schema versions stepwise, stamping only `schemaVersion` and never rewriting existing steps.

迁移按 v0 → v1 → v2 → v3 → v4 逐步进行；迁移后的旧录制保持原有步骤序列与回放行为。v2 → v3 只做 Reference 元数据升级：变量类型按映射改写（`text`→`string`、`email`→`string` 附加 email 格式预设校验、`number`→按默认值含小数点判 `integer`/`decimal`、`date`/`secret`/`file` 保持），缺失的 label 由共享启发式按步骤证据回填，必填/校验/活动关联缺省为空。v3 → v4：结构化 `validation` 经 describe 语义转换为中文句子写入 `rules` 自由文本字段后移除，`locator` 按步骤证据回填，`required`/`label`/`type`/`activities`/`file` 原样保留。高于 `SCHEMA_VERSION` 的版本被拒绝而不是降级。

#### Scenario: v1 录制迁移
- **WHEN** 加载 schema v1 的历史录制
- **THEN** 迁移为 v4 版本标记，步骤序列与回放行为不变

#### Scenario: v2 类型映射
- **WHEN** 加载一个含 `email` 类型变量的 schema v2 Flow
- **THEN** 迁移后该变量类型为 `string`，经 v4 转换其规则文本包含 email 格式语义，模板引用与默认值不变

#### Scenario: v3 规则转文本
- **WHEN** 加载一个变量携带结构化校验（如转大写 + email 预设 + 公式）的 schema v3 Flow
- **THEN** 迁移后该变量的 `rules` 为等义中文句子（如「自动转大写；必须是邮箱格式；值自动计算：今天+7 天」），`validation` 不再存在

#### Scenario: 拒绝未来版本
- **WHEN** 加载 `schemaVersion` 高于当前 `SCHEMA_VERSION` 的 Flow
- **THEN** 拒绝加载并报错，不尝试降级

### Requirement: Reference metadata SHALL be schema-declared and versioned with the Flow

Reference 对象元数据 SHALL 作为 Flow 的一部分经 Zod 声明并随 Flow 版本落盘：`flow.variables` 条目携带 `label`（业务显示名）、`type`（封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`）、`required`（显示名 Mandatory）、`rules`（自由文本规则，程序不解析）、`locator`（来源定位描述）、`activities`（L1 分组 id 数组）、`file`（可选附件元数据：文件名 + 相对工件路径，文件类对象专用）；`flow.referenceFiles` 数组持久化上传文件（文件名、类型、相对工件路径）。结构化 `validation` 字段自 v4 起不再声明（读取时剥离）。变量机器键（name）与 `{{name}}` 模板语法保持 ASCII 标识符不变，schema 剥离未声明字段。

#### Scenario: 未声明字段剥离
- **WHEN** 保存一个变量携带 schema 未声明字段（含旧 `validation`）的 Flow
- **THEN** 该字段被剥离，不进入持久化结果

#### Scenario: 模板键不变
- **WHEN** 加载并重新保存一个迁移到 v4 的旧 Flow
- **THEN** 步骤值中的 `{{url_1}}` 等模板引用与变量机器键逐字节保持
