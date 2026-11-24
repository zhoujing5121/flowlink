# Refine Lifecycle Specification

## Purpose

Refine 演进契约：Record 与多源生成新 Refined 条目、单个 Refined 源的原地迭代（pending 暂存与 Confirm/Discard 决议）、版本冲突拒绝、Confirm 自动历史快照，以及接管修复的直接落盘。

## Requirements

### Requirement: Refining a Record or multiple sources SHALL create a new Refined entry

每次 refine 单条原始录制（Record）SHALL 生成一条全新的 Refined 条目（源录制永不改动，多次 refine 并立多条）；当 refine 的来源是任意多源组合（Record+Record、Record+Refined、Refined+Refined）时，同样 SHALL 生成一条新的合并 Refined 条目。只有"唯一来源是单个 Refined 记录"的情形走原地迭代（见后续 requirement）。

#### Scenario: Record 连续 refine 两次
- **WHEN** 用户对同一条 Record 先后执行两次 refine
- **THEN** 生成两条相互独立的 Refined 条目，Record 本身与首次产物都不被第二次 refine 改动

#### Scenario: Record 与 Refined 混合多源
- **WHEN** refine 来源同时包含一条 Record 和一条 Refined
- **THEN** 生成一条新的合并 Refined 条目，不更新任何来源的既有记录

### Requirement: Refining a single Refined source SHALL stage a pending version without touching the official flow

唯一来源是单个 Refined 记录时，refine 结果 SHALL 暂存为该录制工件目录下的 pending 临时文件；正式 Flow 文件 SHALL 保持不变（version、步骤、变量均不落盘），回放、Test、Instruction 编辑在 Confirm 前都针对正式版本。pending 文件 SHALL 在应用重启后仍可被 Confirm 或 Discard。

#### Scenario: pending 生成后正式文件不变
- **WHEN** 单 Refined 源的 refine 成功并产生 pending
- **THEN** 该录制正式 Flow 文件的 version 与内容保持生成前的状态

#### Scenario: 应用重启后 pending 仍在
- **WHEN** pending 未决议时用户关闭并重新打开应用
- **THEN** 该 Refined 记录仍可看到 pending 的 Confirm / Discard 操作入口

### Requirement: A pending version SHALL resolve only through explicit Confirm or Discard

pending SHALL 只能由用户显式决议：Confirm 将 pending 内容以 version+1 写入正式 Flow、写入生效前历史快照、删除 pending 文件；Discard SHALL 立即删除 pending 文件且正式版本不受影响。已有未决议 pending 时再次触发 refine，SHALL 直接以新结果覆盖旧 pending，不追加、不询问。

#### Scenario: Confirm 落盘并快照
- **WHEN** 用户对 pending 点击 Confirm
- **THEN** 正式 Flow version 递增、旧版进入历史快照、pending 文件消失

#### Scenario: Discard 立即生效
- **WHEN** 用户对 pending 点击 Discard
- **THEN** pending 文件被删除，正式 Flow 保持原样

#### Scenario: 新 refine 覆盖旧 pending
- **WHEN** 存在未决议 pending 时用户再次对该 Refined 记录触发 refine
- **THEN** 新结果直接覆盖旧 pending，无额外确认步骤

### Requirement: Confirm SHALL reject a pending version staged against a changed official flow

pending SHALL 记录生成时的正式版本号（base version）。Confirm 时若正式 Flow 的 version 已不等于 base version（pending 存续期间发生过手工编辑等落盘修改），Confirm SHALL 拒绝落盘并提示用户重新生成，绝不覆盖更新过的正式版本。

#### Scenario: pending 期间发生手工编辑
- **WHEN** pending 未决议时用户在 Instruction 页保存了一次编辑，随后点击 Confirm
- **THEN** Confirm 被拒绝并提示"生成后有过新修改，请重新生成"，正式 Flow 保持手工编辑后的状态

### Requirement: Every pending version SHALL be created together with a structured change list

每次产生 pending 的同时 SHALL 产出结构化变更清单：相对正式版本的步骤新增/删除/修改（带步骤名）、顶层分组的增删与改名、登录网关/条件分支的结构性变化。清单 SHALL 以文本形式随生成结果呈现给用户，作为 Confirm 决策依据；系统不提供图形化并排对比。

#### Scenario: 变更清单随生成返回
- **WHEN** 单 Refined 源的 refine 成功
- **THEN** AI 面板消息中呈现该清单，用户无需打开其它视图即可了解本版改动

### Requirement: Takeover repair on a Refined target SHALL persist directly without pending

AI 接管后的自动流程修复以单个 Refined 记录为目标时，SHALL 直接以 version+1 落盘并写入生效前历史快照（回滚兜底），不产生 pending、不需要 Confirm；以 Record 为目标时维持现状另存为新的 REPAIRED- 条目。

#### Scenario: 修复 Refined 目标直接落盘
- **WHEN** 接管结束后自动修复的目标是 Refined 记录
- **THEN** 该记录正式 Flow 立即更新（version+1）且旧版进入历史快照，无 pending 产生

#### Scenario: 修复 Record 目标维持现状
- **WHEN** 接管结束后自动修复的目标是原始录制
- **THEN** 修复结果另存为新的 REPAIRED- 条目，原始录制不变
