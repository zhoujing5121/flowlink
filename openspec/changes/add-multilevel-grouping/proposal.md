# Proposal

## Why

业务上需要表达多级流程结构：L1 业务级（录制后分组/Refine 的业务阶段，即工作区在飞方法论的目标产出）、L2 技术级（现有 group）、L3 详情级（现有 step），且不局限于三级。当前契约把分组限制为扁平 2–6 顶层组，schema 的递归嵌套能力未被启用，编号、编辑器、AI 输出都是两级假设。同时泳道视图（后续 `add-swimlane-and-level-views`）需要「目标系统」维度数据，由录制后分组与 Refine 一并提取。

## What Changes

- **多级分组一等契约**：group 嵌套（group 内含 group，任意深度）成为一等结构——契约校验接受并原样持久化；组/步骤 id 全 Flow 命名空间唯一（重复即拒绝）；空组拒绝；条件分支目标在嵌套下解析为 Flow 内唯一步骤/分组 id。执行器已递归展开（stepId `/` 前缀、分支目标按 step id 首现解析、循环上限按最外层拥有组计数），语义零改动，以永久回归锁定。
- **层级编号体系**：`01` / `01-01` / `01-01-01`（Activity/Task/Action）按树位置生成，超过三级自然延伸（`01-01-01-01`）；Process、Instruction、Test 三处展示一致；扁平旧数据保持现有两级编号。
- **目标系统标签**：group 上的可选 `targetSystem` 自由文本字段（Zod 声明防剥离；同值即同系统；不影响执行）。叶子步骤的有效系统 = 最近祖先组的标签。userRole 不在本 change（纵向 role 维度将来需要时另立）。
- **AI 生成契约多级化**：录制后分组（generation.autoSanitize）与 Refine（generation.refine）输出嵌套结构——顶层必须业务级（L1，2–6 个、完成标志切组、rationale 契约沿用在飞方法论）、L2 技术级可选（简单流程可省）、L3 步骤；输出约束 ≤3 级；同时按录制证据（URL/域名/系统名）提取 L1/L2 组的 targetSystem 标签，证据不足省略不编造。
- **Instruction 与分组操作适配**：组卡按层级嵌套渲染（可折叠）、组卡头 targetSystem 编辑（经 flow:updateSteps 落盘）；删除含子孙的分组需确认并连带清理全部受影响条件分支引用；插入/移动/重录/加节点支持嵌套目标选择。
- **兼容**：旧扁平 Flow 零迁移零 schemaVersion 升级（新字段 additive optional，嵌套旧版本已可解析）；Process 画布渲染嵌套分组（外层组卡包含内层组卡），级别切换与泳道视图由后续 change 实现。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `flow-schema`：
  - 「Flow IR 覆盖全步骤族与 v2 控制流」requirement：条件分支目标的表述放宽到嵌套任意深度。
  - 新增「嵌套分组为一等校验结构」requirement（嵌套持久化、id 唯一、空组拒绝、执行兼容）。
  - 新增「分组携带可选目标系统标签」requirement（targetSystem 字段契约）。
- `ai-integration`：
  - 「生成提示词分组不变量」requirement：扁平 2–6 顶层组 → 嵌套多级输出 + targetSystem 提取。
- `renderer-ui`：
  - 「Process 标签页渲染语义图」requirement：节点支持嵌套分组层级呈现。
  - 「Instruction 两层编辑视图」requirement：组卡嵌套层级化 + targetSystem 编辑。
  - 「步骤菜单结构守卫」requirement：嵌套删除守卫与目标选择。
  - 新增「层级编号一致性」requirement（01/01-01/01-01-01 树位置编号三处一致）。

## Impact

- `engine/schema/src/schema.ts`（targetSystem 字段、嵌套契约校验、id 唯一性校验）；`io.ts` 无迁移。
- `engine/executor/src/steps.ts`、`run.ts`：行为零改动，补 node:test 嵌套回归。
- `config/prompts.json`（autoSanitize/refine 模板多级输出与标签提取，在 `refine-business-grouping-pi-knowledge` 落地版本之上修改）。
- `renderer/app.js`、`renderer/flow-graph.js`（buildGraph 嵌套节点推导、编号生成）、`renderer/index.html`（嵌套组卡模板）。
- 测试：`tests/` 新增 schema 嵌套校验、执行器嵌套回归、生成输出契约永久回归。
- 依赖顺序：建议在 `refactor-process-canvas-x6` 之后执行（同改 app.js，避免并行冲突）。

## Out of Scope

- 级别切换器、泳道双视图、Expend/Collapse 工具栏（`add-swimlane-and-level-views`）。
- userRole 字段与角色维度（纵向 role 泳道将来需要时另立 change）。
- 全局系统目录（catalog）管理与跨 Flow 一致性治理。
- schemaVersion 升级与数据迁移。
- 执行器语义改动（分支路由、循环上限、Pending/Skipped）。
- 录制器本身（录制仍产出扁平步骤，多级分组由录制后 AI 生成与 Refine 产生）。
