# Design

## Context

数据基础（见 proposal.md 与 `engine/schema/src/schema.ts`）：`StepSchema` 递归（嵌套 group 已合法）；执行器 `flattenSteps` 已递归展开（扁平 stepId `/` 前缀），条件分支目标 = Flow 内唯一 step id 解析为扁平下标（重复 id 防御性取首现），循环上限（FLOW_LOOP_LIMIT 3 次）按最外层拥有分组计数。分组由录制后 AI 生成（`generation.autoSanitize`，提案制）与 Refine 产生；`refine-business-grouping-pi-knowledge`（在飞）已落业务阶段分组方法论。UI 编号现状：`ensureProcessGroups` 为顶层组分配 `01`…，步骤代码 = 组号-序号。

## Goals / Non-Goals

**Goals:**

- 嵌套分组贯穿 schema 契约、AI 输出、Instruction 编辑、Process 渲染、编号体系；任意深度合法，AI 输出 ≤3 级。
- targetSystem 标签字段与 AI 提取落地（消费方泳道视图在后续 change）。
- 执行器零行为改动，永久回归锁定。

**Non-Goals:**

- 级别切换器/泳道视图/Expand 工具栏（`add-swimlane-and-level-views`）。
- userRole（纵向 role 维度将来需要时另立 change，additive）。
- 全局系统目录、标签一致性治理。
- schemaVersion 升级与迁移（additive optional，旧数据天然合法）。

## Decisions

### D1 嵌套契约

- 层级语义由嵌套深度表达，不加 group 类型/级别字段：顶层=L1 业务级、第二层=L2 技术级、叶子=步骤；>3 级合法（手工编辑或未来需要），AI 输出约束 ≤3 级且「顶层业务级、简单流程可省 L2」。
- 校验升级：id 唯一性从「防御性取首现」升级为契约拒绝（校验器在递归遍历中收集 id 并查重，组 id 与步骤 id 共享命名空间）；空组拒绝；分支目标存在性检查扩展到嵌套任意深度（现有递归收集已覆盖，确认即可）。
- 编号实现：`renderer/flow-graph.js` 新增纯函数 `numberingOf(flow)`（树位置 → 层级编号），Process/Instruction/Test 共用；编号为展示派生量，不落盘。`ensureProcessGroups` 的现有编号逻辑收敛到该函数，扁平数据输出与现状一致。

### D2 targetSystem 标签

- 字段挂在 group 步骤对象上（任意层级），叶子步骤的有效系统 = 最近祖先组的标签（消费方按此推导，不在步骤上冗余存储）。
- 自由文本、trim 后原样比较；同值即同系统；不做同义归并（治理留给未来目录 change）。
- 编辑入口：Instruction 组卡头（唯一编辑面，经 `flow:updateSteps` 落盘）；Process 画布只读展示。

### D3 AI 生成契约

- `generation.autoSanitize` / `generation.refine` 模板输出改为嵌套结构；输出 schema 校验扩展：顶层组数 2–6、深度 ≤3、组标签/rationale 必填项、targetSystem 为可选字符串。
- 保留在飞 change 的全部纪律（完成标志切组、四层质量门、SSO/登录门、变量模板、`$ref` 纪律）；在其落地的 prompts.json 版本之上修改。
- 永久回归（node:test）：嵌套输出校验合法/畸形用例（深度超限、顶层组数越界、标签非字符串）。

### D4 执行兼容锁定

- executor 代码零改动；node:test 覆盖：嵌套扁平化前缀 stepId、条件目标任意深度解析与首现去重语义（唯一化后该语义成为校验前置不变量）、循环上限按最外层拥有分组、删嵌套组的分支清理（renderer 侧清理逻辑若有纯函数部分一并覆盖）。

### D5 Instruction 与菜单适配

- 组卡递归渲染：`index.html` `<template>` 定义单层组卡模板，JS 递归填充（遵守模板纪律）；内层默认折叠可展开。
- 删除守卫：删含子孙的组 → 确认对话框（列明影响步骤数）→ 连带删除 + 分支引用清理（复用现有删空组清理逻辑，扩展到子孙范围收集）。
- 移动/插入/重录/加节点的目标选择器支持嵌套层级（分组选择列表按层级缩进展示）。

### D6 Process 嵌套渲染（无级别切换的基线形态）

- X6 画布（`refactor-process-canvas-x6` 产物）上嵌套分组 = 外层组卡包含内层组卡（X6 parent/child 容器），组间边按执行语义连接外层维度；扁平数据渲染与现状一致。级别切换与聚合视图留给 C。

## Risks / Trade-offs

- [AI 嵌套输出质量不稳] → 输出 schema 严格校验畸形即败（不产半成品）+ 多录制样本真机验证；约束 ≤3 级降低主观性。
- [id 唯一性校验拒绝历史数据] → 校验只对新写盘生效；旧数据若存在重复 id（历史防御性容忍），加载不迁移、保存时才暴露——首次保存报错并列出冲突 id，用户可改 id 后保存。
- [Instruction 深层嵌套编辑路径变长] → 内层默认折叠 + 编号定位（01-01-01 直接对应）。
- [编号派生与现有 ensureProcessGroups 双轨] → 收敛到单一 number 函数，一次性替换。

## Migration Plan

无 schemaVersion 升级、无数据迁移。回滚 = git revert。

## Open Questions

（无——库无关、行为边界已定；Instruction 折叠默认层级在实现时按手感微调。）
