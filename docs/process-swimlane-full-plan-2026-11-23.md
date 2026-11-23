# Process 泳道可编辑化 · Full Plan（完整档）

> 2026-11-23 定稿。三档终态方案之一（Lite / Standard / Full 三选一，**非阶段**）。
> 本档定位：原 A + B 两计划与真并行执行合并的终极方案——Workflow（扁平 steps + 显式边）/ Process Definition（Activity/Task/Role/TouchPoint 业务结构）/ View（布局）三层解耦；**group 树一步拆解**；Fork/Join 真并行执行；B 的全部增强并入。约 9.5–12.5 周（各阶段估时加总，见 §7；画布选型继续用 X6 3.x，改用其内置编辑插件，见 §11）。
> 相对原 A/B 的修正：①group 树拆解（原 A 未定义其命运，双分组系统是最大隐患）；②Object = Reference 投影（原 A 的 ProcessObject 与刚落地的 Reference 重复建模）；③Fork/Join 从 Out-of-Scope 改为真并行（grill 定案）；④execution 类型规则定案：录制=manual（用户手动点击采集）、手动添加=manual、Refine 由 AI 判定、用户可手动改——与原 A §7 一致；⑤Instruction/Test 迁移显式入范围（原 A/B 只字未提，拆树后无选择）；⑥View 布局存语义网格位置；⑦补 Phase 0 前置。

## 0. 共同背景（三档共用）

**现状**（截至 2026-11-23，全部未提交）：
- 画布：AntV X6 3.x（`renderer/app.js` ~1108 `ensureProcessX6`、~1858 `buildSwimlaneCells`、~2075 `fillProcessPanel`）；纯数据推导在 `renderer/flow-graph.js`（`flattenFlowSteps` :35 / `numberingOf` :72 / `buildGraph` :134 / `buildSwimlane` :553）。
- 泳道现状：纯视图、不可编辑；列 = `targetSystem`（group 可选自由文本，最近祖先继承），行 = L1 阶段带；卡 = L2 组卡。
- 数据模型：嵌套 group 树（`engine/schema/src/schema.ts` :356/:383，`condition` 挂 group，stepId 带组前缀如 `g2/a1`）；执行 = 顺序数组 + 条件组分支 + 回跳；无 role、无显式边、无并行。
- Reference 正式化（`openspec/changes/formalize-reference/`）已实现未提交：`flow.variables`（label/类型/必填/校验/`activities[]`）、`flow.referenceFiles`、schema v3、`engine/reference` 包、D8 `deriveActivities` 证据推导。
- 测试基线：`npm run build` + `npx tsc --noEmit` + `npm test`（86 过/0 败）。

**既定决策（grill 定案）**：行 = 角色（WHO）、列 = 系统 touch-point（WHERE），阶段带移除（阶段 = Activity 在 Flow 视图看）；Activity→Task→Action 固定三层、schema 预留嵌套不暴露 UI；显式连线编辑为原生交互（边即执行模型）；Fork/Join 真并行执行；Object = Reference 投影。

**Phase 0 前置（必做）**：提交并真机验证 X6 画布三 change + formalize-reference（`docs/canvas-multilevel-verification-2026-11-22.md` 清单，reference 剩 7.4）。

## 1. 目标架构（三层解耦）

```text
Process Aggregate（同一 ProcessId / Revision，单文件逻辑分区）
├── Workflow（执行权威）
│   ├── steps：扁平叶子步骤（唯一执行动作内容，stepId 不再带组前缀）
│   └── edges：显式边 [{ id, from, to, kind: 'seq'|'condition'|'jump'|'fork'|'join', condition?, label? }]
├── Process Definition（业务结构）
│   ├── activities：[{ id, name, order }]                       ← L1 业务阶段
│   ├── tasks：[{ id, activityId, name, order, children? }]     ← L2 工作单元（children 预留嵌套，UI 不暴露）
│   ├── roles / touchPoints：[{ id, label, order }]
│   └── step.processRefs：{ taskId }（成员归属权威，Process 侧索引派生可重建）
├── Objects（不新增实体）
│   └── = flow.variables + flow.referenceFiles（Reference 正式化成果）
│       object flow = 模板使用证据推导（D8 同款遍历）+ overrides
└── Views（仅布局）
    └── swimlane / flow：语义网格位置（roleId/touchPointId/orderInCell），像素推导
```

依赖规则：Workflow 不依赖渲染库；Process 不复制 Step 执行内容；View 不含执行/业务权威字段；Executor 只读 Workflow（忽略 processRefs）；Recorder / AI / UI 统一经 Process Authoring Service 写入，不直接拼 JSON。

**group 树拆解**：L1 → Activity、L2 → Task；组内顺延 → seq 边；组 condition → condition 边实体（判定点 = 组末步骤或独立判定节点）；回跳 → jump 边。condition 求值器复用现有实现，仅数据来源从 group 字段迁到边实体。

**execution 类型规则**（2026-11-23 用户定案，三档共同的产品语义）：录制产物 = `manual`（用户手动点击采集）；用户手动添加默认 = `manual`；Refine 时由 AI 逐 step 判定 `manual`/`automated`（证据不足 = `manual`）；用户可随时手动改 `manual` ↔ `automated`。Task 的 Automated/Manual/Mixed 从成员 Steps 聚合显示，不单独存储；Task 卡切换执行方式时批量更新其成员 Steps。

## 2. 真并行执行（Fork/Join）

- **执行器**：`engine/executor` 从顺序解释器改为边图解释器（拓扑游走 + 条件求值）。fork 边到达 → 并发执行各分支；join（AND 语义）等全部分支 settle。
- **隔离单元**：分支 = 同一浏览器 context 内独立 tab（复用现有 tab 管理机制）；跨 context 隔离（SSO 冲突系统场景）列为后续配置项，本档不做。
- **失败语义**：分支内失败 → 该支标红继续他支；join 汇合后任一支失败则整体 run 判失败（不做补偿/重试）。
- **停止语义**：停止按钮取消全部分支。
- **变量语义**：fork 时变量表快照只读传入；分支写本地副本；join 合并（同名冲突按分支序取后到者，冲突清单写入 run 日志）。
- **进度/回放 UI**：Test 进度列表与 Process 回放 overlay 支持并行分支分区显示（各支独立绿/红/灰状态）。
- **录制不产并行**：录制仍单线程；并行结构来自用户编辑或 AI 生成。

## 3. 泳道编辑（全量）

- 行 = Role、列 = TouchPoint、空行/空列增删、整行/列拖拽重排（order 落盘）、格 = role×touchPoint 交点、格内加 task（建 Task 实体 + processRefs）。
- 四级拖拽（行/列/格/task）全部语义回写 + 吸附高亮；无坐标落盘。
- 编辑基座用 X6 3.x 内置插件与核心能力（`Snapline` / `Selection` / `Keyboard` / `Clipboard` / `Dnd`；`embedding` 落点检测；`connecting` + 边工具），不自研；撤销/重做在命令层，不启用 X6 `History`（见 §11）。
- 原生显式连线编辑：边即模型，拖线建边/改边/删边；condition/jump/fork/join 边类型在工具栏可选；非法拓扑（如 join 无对应 fork、悬空边）保存校验拒绝。
- Object 节点 = Reference 投影（label + 类型图标）；object flow 证据推导 + 人工补线（非执行）。
- Flow 视图：`buildGraph` 改从 edges 推导（分段/并行链逻辑由 fork/join 边显式表达，不再依赖 sourceFlowId 启发式分段）；级别切换收敛为固定三层（Activity/Task/Action + Expand 明细）；编号 01/01-01 派生自 Activity/Task 序。

## 4. Instruction / Test / AI / 回放迁移（拆树强制项）

- Instruction/Test 双面板从 Activity/Task 推导（三层卡 + 明细行），编号与 Process 一致；回放对齐仍走扁平 stepId（展平后 stepId = 叶子原 id，`flattenFlowSteps` 简化为恒等 + processRefs 关联）。
- AI refine 契约重写（`config/prompts.json` + `src/ai-refine.ts`）：输出 Activity/Task 划分建议 + processRefs + 逐 step execution 判定（manual/automated，不再输出嵌套 group 树）；variableLabels 契约不变；`activities[]` 指向 Activity id；targetSystem 证据 → touchPoint 建议。
- 86 存量测试 + fixtures 全量迁移重写；新增永久回归：边模型推导、并行执行语义（fork/join/失败/停止/变量合并）、迁移等价性（旧 group 流迁移后执行行为逐字节等价）。

## 5. B 增强并入

- 修订号冲突检测：refine 异步生成期间用户已编辑 → 基于旧修订的结果要求重合并，不覆盖。
- run 固定 revision：Run 引用 Process/Workflow 修订号，历史报告按运行时固定修订重建泳道归属。
- Change Set / Undo-Redo 跨 Workflow/Process/View 三分区原子。

## 6. 迁移（schema v3 → v4，结构迁移）

- 一次性迁移器（`migrateFlow` 扩展，惰性执行于首次加载）：group 树 → Activity/Task + edges；`targetSystem` → touchPoint 实体建议；Lite 档的 `actor` 标签（若曾用过 Lite 档）→ Role 实体。
- stepId 展平：保留叶子 id、去组前缀；历史 run 自带流程快照不受影响（按其自身快照对齐）；`.bak` 回滚机制沿用。
- 旧 Flow（纯录制扁平）迁移 = 单 Activity 单链 seq 边，行为等价。

## 7. 实施阶段（估 9.5–12.5 周）

| 阶段 | 内容 | 估时 |
|---|---|---|
| 0 | 前置收尾（提交 X6 三 change + reference 真机验证） | 0.5 周 |
| 1 | schema v4 + 边模型 PoC + 迁移器 + 等价性回归框架 | 1–1.5 周 |
| 2 | 执行器边图化（顺序场景与现状执行等价，全量回放回归） | 1.5–2 周 |
| 3 | Fork/Join 真并行（tab 隔离/失败/停止/变量合并/进度 UI） | 2–3 周 |
| 4 | Process Definition + Authoring 全命令族 + 三层投影/编号/Instruction/Test 迁移 | 2 周 |
| 5 | 泳道全编辑 + Object 投影 + 原生连线编辑（含 X6 插件接入冒烟） | 1–1.5 周 |
| 6 | AI refine 契约重写 + 修订号冲突 + run 修订固定 | 1 周 |
| 7 | 全量回归 + 真机验证 | 0.5–1 周 |

主要文件：`engine/schema/src/schema.ts`、`engine/executor/src/*`（重写）、`engine/executor/src/steps.ts`（stepId 前缀约定废除）、`renderer/flow-graph.js`（推导层重写）、`renderer/app.js`、`src/main.ts`、`src/ai-refine.ts`、`src/process-authoring.ts`（新）、`config/prompts.json`；`tests/` 全量迁移 + `tests/edges-parallel.test.mjs`（新）等。

## 8. 验收标准

1. 三层解耦成立：Executor 不依赖 Process/渲染；View 无执行权威字段；AI/UI 同一命令入口（依赖测试覆盖）。
2. 拆树等价：旧 group 流迁移后顺序执行行为与迁移前一致（永久回归）；stepId 展平后回放/报告对齐。
3. 并行专项：fork 两支真并发（不同 tab）、一支失败他支继续、join 等全、整体判败、停止取消全部、变量快照合并 + 冲突日志、进度/overlay 分支着色。
4. 泳道全编辑：空行列/整行列重排/格内加 task/四级拖拽语义回写/吸附整洁；连线原生编辑含 fork/join；非法拓扑拒绝；多选/快捷键/复制粘贴经命令入口可用。
5. Object 与 Reference 页同源一致；object flow 证据推导 + 补线。
6. Instruction/Test/Process 三处编号一致（Activity/Task/Action 三层）。
7. AI refine 输出新契约（含逐 step execution 判定）；录制/手动添加默认 manual 且用户可改；并发编辑冲突不覆盖；run 按固定修订重建。
8. build + tsc + test 全绿；真机清单全过（Windows Electron）。

## 9. 真机验证清单

- [ ] 旧三型 Flow（纯录制 / 多源 AI 合并 / 多阶段嵌套）迁移 → 执行等价 → 回放正常
- [ ] 泳道全编辑操作族（行列格卡 + 拖拽吸附 + 连线 + 撤销）
- [ ] Fork/Join 场景：双分支并行跑、失败分支、停止、变量合并日志
- [ ] refine 重分组 → 新 Activity/Task 归属三处一致
- [ ] refine 期间手动编辑 → 冲突提示
- [ ] 历史 run 报告打开 → 泳道按当时修订重建

## 10. 风险

- **执行器重写回归面最大**（rrweb 回放 / playback / 进度 / 批量）→ 阶段 2 以「顺序场景逐字节等价」为硬门，永久回归测试锁死。
- 并行变量语义复杂 → 封闭为快照+合并模型并文档化，不做锁/事务。
- 时间线最长（9.5–12.5 周）→ 若中途需要提前交付编辑能力，可事实性先落 Lite 档作过渡（非计划依赖，纯可选）。
- X6 画布与 reference 基座未提交未真机验证 → Phase 0 硬前置，未过不开工。
- X6 插件与 HTML 节点在 Electron 45 下的兼容性未冒烟 → 阶段 5 以「插件接入冒烟」开头，失败项回退为自研交互（估时上限已含）。

## 11. 画布引擎选型

结论：**继续用 X6 3.x，改为「内置编辑插件 + 自定义语义层」**。对比与证据见 [画布技术选型对比](process-swimlane-canvas-selection-2026-11-23.md)。

- 零新增依赖：编辑插件在 X6 3.x 已并入主包，并经 `window.__flowlinkX6`（`{ ...es_exports }` 全量导出）暴露——构建产物中 `Snapline` / `Selection` / `Keyboard` / `Clipboard` / `Dnd` / `History` / `Transform` 等类均已核实存在。
- 用法清单与接线约定（格为父节点、`embedding` 落点检测、语义回写后重推导、回放态整体只读、撤销在命令层而非 `History`）见选型文档 §5。
- 阶段 5 以「插件接入冒烟」开头：在 Electron 45 + HTML 节点下先跑通插件再接语义回写。
