# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Reference metadata SHALL be schema-declared and versioned with the Flow

Reference 对象元数据 SHALL 作为 Flow 的一部分经 Zod 声明并随 Flow 版本落盘：`flow.variables` 条目扩展 `label`（业务显示名）、`type`（新封闭枚举 `url`/`string`/`integer`/`decimal`/`date`/`secret`/`excel`/`word`/`csv`/`md`/`file`）、`required`、`validation`（大小写/格式预设与正则/正负/条件表达式/公式表达式）、`activities`（L1 分组 id 数组）、`file`（可选附件元数据：文件名 + 相对工件路径，文件类对象专用）；新增 `flow.referenceFiles` 数组持久化上传文件（文件名、类型、相对工件路径）。变量机器键（name）与 `{{name}}` 模板语法保持 ASCII 标识符不变，schema 剥离未声明字段。

#### Scenario: 未声明字段剥离
- **WHEN** 保存一个变量携带 schema 未声明字段的 Flow
- **THEN** 该字段被剥离，不进入持久化结果

#### Scenario: 模板键不变
- **WHEN** 加载并重新保存一个迁移到 v3 的旧 Flow
- **THEN** 步骤值中的 `{{url_1}}` 等模板引用与变量机器键逐字节保持
