# Spec Delta

## MODIFIED Requirements

### Requirement: The Flow IR SHALL cover the full step family and schema v2 control flow

The Flow IR SHALL cover the full recorded step family, schema v2 control flow, and provenance fields.

步骤族覆盖导航、点击、输入、选择、按键、悬停、滚动、拖拽、上传、等待、断言、条件、抽取、脚本、对话框、标签页开/关/切换与分组。v2 条件分支：断言 + 可选真/假分支目标；**条件步骤可位于组内任意位置**（不再强制组末）；分支目标为**同 Flow 内任意已存在步骤的 id**（不再限于顶层组；步骤 id 全局唯一，组 id 与步骤 id 共享命名空间），执行时跳转到该步骤（含其所在组的后续序列）；缺省分支表示顺序继续（不再是终止语义）。`settle` 对象、`timeout` 字段，以及来源字段 `meta.sourceFlows[]`（AI 合并的直接来源链）与 `step.sourceFlowId`（按元素库来源推断的启发式标注，仅用于图形分段，不影响执行）保持不变。

#### Scenario: 悬空分支引用被拒绝
- **WHEN** 条件步骤的分支目标指向不存在的步骤 id
- **THEN** 契约校验失败，Flow 不落盘

#### Scenario: 组中条件合法
- **WHEN** 条件步骤位于某组中间且分支目标为另一组内的具体步骤
- **THEN** 契约校验通过（不因非组末位置或非组级目标被拒绝）

#### Scenario: 来源字段参与持久化
- **WHEN** 保存一个 AI 合并生成的 Flow
- **THEN** `meta.sourceFlows` 与各步 `sourceFlowId` 被保留（字段已在 schema 声明，Zod 不会剥离）
