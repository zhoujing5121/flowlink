# Process 泳道可编辑化 · Standard Plan（标准档）

> 2026-11-23 定稿。三档终态方案之一（Lite / Standard / Full 三选一，**非阶段**）。
> 本档定位：原 A/B 计划的修正版——统一写入路径 + lanes 主数据 + 显式连线 UI（映射到现有顺序+条件执行模型）+ Object = Reference 投影。**group 树保留**（分组与执行语义仍归树，泳道归属归主数据），不拆树、不动执行器。约 4.5–6 周（各阶段估时加总，见 §5；画布选型继续用 X6 3.x，改用其内置编辑插件，见 §9）。
> 相对原 A/B 的修正：①不引入 Activity/Task 双分组实体（避免与 group 树双事实源）；②Object 复用刚落地的 Reference，不建 ProcessObject；③execution 类型规则定案：录制=manual（用户手动点击采集）、手动添加=manual、Refine 由 AI 判定、用户可手动改（与原 A §7 一致）；④View 布局存语义网格位置而非像素；⑤补 Phase 0 前置。

## 0. 共同背景（三档共用）

**现状**（截至 2026-11-23，全部未提交）：
- 画布：AntV X6 3.x（`renderer/app.js` ~1108 `ensureProcessX6`、~1858 `buildSwimlaneCells`、~2075 `fillProcessPanel`）；纯数据推导在 `renderer/flow-graph.js`（`flattenFlowSteps` :35 / `numberingOf` :72 / `buildGraph` :134 / `buildSwimlane` :553）。
- 泳道现状：纯视图、不可编辑；列 = `targetSystem`（group 可选自由文本，最近祖先继承），行 = L1 阶段带；卡 = L2 组卡。
- 数据模型：嵌套 group 树（`engine/schema/src/schema.ts` :356/:383，`condition` 挂 group）；执行 = 顺序数组 + 条件组分支；无 role 字段、无显式边。
- Reference 正式化（`openspec/changes/formalize-reference/`）已实现未提交：`flow.variables` 带 label/类型/必填/校验/`activities[]`、`flow.referenceFiles`、schema v3、`engine/reference` 包、D8 `deriveActivities` 证据推导。
- 测试基线：`npm run build` + `npx tsc --noEmit` + `npm test`（86 过/0 败）。

**既定决策（grill 定案）**：行 = 角色、列 = 系统（touch-point）、阶段带移除；Activity→Task→Action 三层概念保留（本档由 group 树 L1/L2 承担）；「自由改连接」必须可用（本档 = 显式连线 UI 写回顺序+条件）；Object = Reference 投影；Fork/Join 本档仅视觉（保存校验标「不可执行·仅示意」）。

**Phase 0 前置（必做）**：提交并真机验证 X6 画布三 change + formalize-reference（`docs/canvas-multilevel-verification-2026-11-22.md` 清单，reference 剩 7.4）。

## 1. 目标 / 不做

**目标**：
- 泳道全量编辑：行/列主数据（空行空列、增删、整行整列拖拽重排落盘）、格内加 task、行/列/格/task 四级拖拽语义回写 + 网格吸附。
- 显式连线编辑 UI：拖线改后继/分支目标，写回为数组 reorder + condition 更新。
- Object = Reference 投影：泳道 Object 节点 + 证据推导的 object flow。
- 统一写入路径：UI 与 AI refine 共用命令 + 校验 + 原子保存（B 的核心并入）。
- B 增强：refine 修订号冲突检测、run 固定修订号。

**不做**：拆 group 树（分组/执行仍归树，终极解法在 Full 档）；Fork/Join 执行语义（仅视觉）；Object 执行依赖；Activity/Task 独立实体；Instruction/Test 改推导源（仍从 group 树，行为不变）。

## 2. 数据模型（schema v3 → v4，additive）

```ts
// flow 新增逻辑分区（同文件，不拆双文件）
flow.lanes = {
  roles:      Array<{ id: string; label: string; order: number }>,
  touchPoints: Array<{ id: string; label: string; order: number; legacySystem?: string }>,
}
// group 新增（Zod 显式声明，防 strip）
group.roleId?: string        // 未设 → 「未分配」行
group.touchPointId?: string  // 未设 → 沿用 targetSystem 文本推导 → 「未标注」列
// 视图布局：语义网格位置，像素由布局推导（不存坐标）
flow.views.swimlane = {
  cells: Record<groupId, { roleId: string; touchPointId: string; orderInCell?: number }>,
  objectFlowOverrides?: Array<{ from: string; to: string }>,  // Object 补线（非执行）
}
```

- 空行/空列 = 主数据里有、无卡片引用的 role/touchPoint；整行/列拖拽重排 = 改 `order` 落盘。
- 迁移线索：首次打开含 `targetSystem` 的旧 Flow，生成 touchPoint 建议（label = targetSystem 文本），用户确认后建实体；不自动改写原字段。
- Object 无新 schema：节点 = `flow.variables` + `flow.referenceFiles`（label/类型目录/activities[] 都有）；object flow 边 = 模板使用证据推导（复用 formalize-reference D8 `deriveActivities` 的遍历法，粒度到 L2 组）+ 人工补线存 overrides。
- execution 类型规则（2026-11-23 用户定案）：录制产物 = `manual`（用户手动点击采集）；用户手动添加默认 = `manual`；Refine 时由 AI 逐 step 判定 `manual`/`automated`（证据不足 = `manual`）；用户可随时手动改 `manual` ↔ `automated`；Task（组卡）从成员聚合显示，不改存储。

## 3. 架构与依赖方向

```text
engine/schema（契约） ← engine/reference（已存在）
        ↑
src/process-authoring.ts（新：命令 + 校验，主进程）
  命令族：CreateRole/RenameRole/DeleteRole/ReorderRoles
          CreateTouchPoint/RenameTouchPoint/DeleteTouchPoint/ReorderTouchPoints
          AssignLane（卡→行/列）  ReorderSteps  UpdateConditionBranch
          UpdateObjectFlowOverride  UpdateSwimlaneLayout
  每命令声明影响域：workflow 执行变更 / 泳道语义变更 / 仅视图变更
        ↑                    ↑
renderer/app.js（UI 编辑）   src/ai-refine.ts（AI 输出转命令草案，不再直接拼 JSON）
        ↓
preload IPC 暴露（同 Reference D3 模式：校验与求值同源，渲染层零 Node 能力）
```

不变量（永久 node:test 覆盖，遵循 2026-11-20 验证基线）：roleId/touchPointId 引用存在；删除实体无悬空引用；视图布局不含执行权威字段；AI 与 UI 同一写入入口；仅视图变更不触发 flow 版本递增的执行快照失效。

## 4. 泳道编辑交互（`renderer/app.js` + `app.css` + X6 3.x 内置编辑插件）

- 行 = Role 实体（order 序）、列 = TouchPoint 实体；未分配/未标注兜底行/列保留。
- 工具栏：添加行/添加列（建空实体）；行头/列头右键：改名/删除（删除时卡片回退到兜底行/列，不删卡）。
- 整行/整列拖拽：拖行头到目标位置 → 改 order 落盘 → 全行重排吸附。
- 格：role × touchPoint 交点；格右键加 task（建 group 继承 roleId/touchPointId）。
- 卡片拖拽：目标行/列 → `AssignLane`；格内/跨格前后 → `ReorderSteps`；拖拽期间显示吸附高亮（目标格描边），松手语义回写、布局重推导，无坐标脏写。
- **显式连线编辑**：卡边缘连线手柄，拖 A→B：改后继 = `ReorderSteps`（A 子树移到 B 后）；按住分支键拖 = `UpdateConditionBranch`（新建/改条件边目标）。不可表达拓扑（多入汇合、跨链回跳超出现有 condition 能力）→ 保存校验拒绝并提示「当前执行模型不支持该连接」。
- Fork/Join：工具栏可放置，仅展示；保存校验标「不可执行·仅示意」徽章；不进执行链。
- Object 节点：Reference 页同源数据（label + 类型图标）；object flow = 证据推导实线（浅色）+ overrides 虚线；点击跳 Reference 页。
- 编辑基座（不自研，见 §9）：`Snapline`（吸附对齐）、`Selection`（多选）、`Keyboard`（快捷键）、`Clipboard`（复制粘贴→命令）、`Dnd`（工具栏拖入 Task/Object/Fork/Join）、核心 `embedding`（落点检测 + 拖拽经过高亮）、核心 `connecting` + 边工具（连线/改接/删除）。撤销/重做在命令层实现，**不启用 X6 `History`**——画布由数据重推导重建，cell 级历史会被重建噪声污染。

## 5. 实施阶段（估 4.5–6 周）

| 阶段 | 内容 | 估时 |
|---|---|---|
| 0 | 前置收尾（提交 X6 三 change + reference 真机验证） | 0.5 周 |
| 1 | schema v4（lanes/views/roleId/touchPointId）+ 迁移线索 + 测试 | 0.5–1 周 |
| 2 | process-authoring 命令族 + 校验 + IPC + 单测 | 1 周 |
| 3 | 泳道编辑交互全量（先做 X6 插件接入冒烟；增删/重排/格/四级拖拽吸附/连线 UI；多选/快捷键/复制粘贴由插件提供） | 1–1.5 周 |
| 4 | Object 投影 + object flow 推导 + overrides | 0.5 周 |
| 5 | AI refine 命令化（输出转命令草案 + Diff）+ 修订号冲突检测 + run 固定修订号 | 0.5–1 周 |
| 6 | 全量回归 + 真机验证 | 0.5 周 |

主要文件：`engine/schema/src/schema.ts`、`src/process-authoring.ts`（新）、`src/main.ts`（IPC）、`src/preload.ts`、`renderer/flow-graph.js`（`buildSwimlane` 改读主数据）、`renderer/app.js`、`src/ai-refine.ts`、`config/prompts.json`；测试新增 `tests/lanes-authoring.test.mjs`、更新 `tests/swimlane-levels.test.mjs`。

## 6. 验收标准

1. 空行/空列增删、整行整列拖拽重排落盘，重开保持。
2. 四级拖拽（行/列/格/task）全部语义回写；无坐标脏写；吸附后布局整洁（重推导保证）。
3. 连线编辑：改后继/分支目标生效且执行序/回放一致；不可表达拓扑被明确拒绝。
4. Object 节点与 Reference 页同源一致；object flow 证据推导正确、补线落盘。
5. AI refine 与 UI 编辑经同一命令入口（refine 逐 step 判定 execution）；录制/手动添加默认 manual 且用户可改；refine 期间用户编辑触发修订号冲突，不静默覆盖。
6. run 报告按固定修订号重建泳道归属。
7. Fork/Join 视觉节点带「不可执行」徽章，不参与执行。
8. 旧 Flow（无 lanes）打开：targetSystem 迁移线索流程可用；未确认前行为与现状一致。
9. build + tsc + test 全绿（86 存量不回归 + 新增）；真机清单全过。
10. 多选、快捷键（Delete / Ctrl+Z / Ctrl+Y / Ctrl+C / Ctrl+V）、复制粘贴可用，且全部经命令入口与校验。

## 7. 真机验证清单

- [ ] 旧 Flow 迁移线索 → 建 touchPoint → 拖卡入列 → 保存重开
- [ ] 空行空列、整行/列拖拽重排
- [ ] 四级拖拽 + 吸附高亮 + 撤销（undo 跨分区恢复）
- [ ] 连线改序/改分支 → 回放验证执行序
- [ ] Object 节点/流展示 + Reference 页联动
- [ ] refine 并发编辑冲突提示
- [ ] 回放 overlay 在新泳道布局下实时正确
- [ ] 多选/快捷键/复制粘贴（经命令入口与校验）

## 8. 风险

- **双轨残留**：分组/执行归 group 树、泳道归属归 lanes，refine 重分组后 roleId/touchPointId 需随命令维护（命令化后单一入口可控）；终极解法在 Full 档（拆树）。
- 连线 UI 写回映射受限（多入汇合不可表达）→ 明确拒绝 + 提示，不做静默近似。
- refine 命令化改造面较大 → 阶段 5 独立成周，失败可回退为「refine 直接 JSON + 后置校验」过渡实现。
- X6 插件与 HTML 节点在 Electron 45 下的兼容性未冒烟 → 阶段 3 以「插件接入冒烟」开头，失败项回退为自研交互（估时上限已含）。

## 9. 画布引擎选型

结论：**继续用 X6 3.x，改为「内置编辑插件 + 自定义语义层」**。对比与证据见 [画布技术选型对比](process-swimlane-canvas-selection-2026-11-23.md)。

- 零新增依赖：编辑插件在 X6 3.x 已并入主包，并经 `window.__flowlinkX6`（`{ ...es_exports }` 全量导出）暴露——构建产物中 `Snapline` / `Selection` / `Keyboard` / `Clipboard` / `Dnd` / `History` / `Transform` 等类均已核实存在。
- 用法清单与接线约定（格为父节点、`embedding` 落点检测、语义回写后重推导、回放态整体只读、撤销在命令层而非 `History`）见选型文档 §5。
- 阶段 3 以「插件接入冒烟」开头：在 Electron 45 + HTML 节点下先跑通插件再接语义回写。
