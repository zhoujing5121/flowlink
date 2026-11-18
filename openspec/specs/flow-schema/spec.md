# Flow Schema Specification

## Purpose

定义 Flow JSON 的权威契约：版本化动作 IR、Zod 校验、迁移与原子写入。录制、编辑、AI 生成与回放所有路径产生的 Flow 都必须经过本契约；本能力不负责采集或回放本身（见 recording 与 replay-execution）。

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

迁移按 v0 → v1 → v2 逐步进行；迁移后的 v1 录制保持原有回放行为。高于 `SCHEMA_VERSION` 的版本被拒绝而不是降级。

#### Scenario: v1 录制迁移
- **WHEN** 加载 schema v1 的历史录制
- **THEN** 迁移为 v2 版本标记，步骤序列与回放行为不变

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

步骤族覆盖导航、点击、输入、选择、按键、悬停、滚动、拖拽、上传、等待、断言、条件、抽取、脚本、对话框、标签页开/关/切换与分组。v2 增加条件分支（断言 + 可选 `trueGroupId`/`falseGroupId`，分支目标必须是已存在的非空顶层分组）、`settle` 对象、`timeout` 字段，以及来源字段 `meta.sourceFlows[]`（AI 合并的直接来源链）与 `step.sourceFlowId`（按元素库来源推断的启发式标注，仅用于图形分段，不影响执行）。

#### Scenario: 悬空分支引用被拒绝
- **WHEN** 条件步骤的分支目标指向不存在或空的顶层分组
- **THEN** 契约校验失败，Flow 不落盘

#### Scenario: 来源字段参与持久化
- **WHEN** 保存一个 AI 合并生成的 Flow
- **THEN** `meta.sourceFlows` 与各步 `sourceFlowId` 被保留（字段已在 schema 声明，Zod 不会剥离）

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
