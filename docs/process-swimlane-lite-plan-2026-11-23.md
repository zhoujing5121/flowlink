# Process 泳道可编辑化 · Lite Plan（轻量档）

> 2026-11-23 定稿。三档终态方案之一（Lite / Standard / Full 三选一，**非阶段**）。
> 本档定位：在现有 group 树与推导层上以最小改动交付「泳道可编辑」的核心可用子集，约 1–1.5 周。
> 代价：可维护性最差（actor 自由文本无主数据、无空行空列、无整行列拖拽），**全部增量在 Full 档落地时废弃**。
> 存在价值判定：Full 档距落地 9.5–12.5 周；本档约 1 周即可让用户真实编辑泳道（改角色/系统归属、格内加任务、改执行顺序），值得做。

## 0. 共同背景（三档共用）

**现状**（截至 2026-11-23，全部未提交）：
- 画布：AntV X6 3.x（`renderer/app.js` ~1108 `ensureProcessX6`、~1858 `buildSwimlaneCells`、~2075 `fillProcessPanel`）；纯数据推导在 `renderer/flow-graph.js`（`flattenFlowSteps` :35 / `numberingOf` :72 / `buildGraph` :134 / `buildSwimlane` :553）。
- 泳道现状：纯视图、不可编辑；列 = `targetSystem`（group 上的可选自由文本，最近祖先继承），行 = L1 阶段带；卡 = L2 组卡。
- 数据模型：嵌套 group 树（`engine/schema/src/schema.ts` :356/:383，`condition` 挂 group）；执行 = 顺序数组 + 条件组分支；无 role 字段、无显式边。
- Reference 正式化（`openspec/changes/formalize-reference/`）已实现未提交：`flow.variables` 带 label/类型/必填/校验/`activities[]`、`flow.referenceFiles`、schema v3、`engine/reference` 包。
- 测试基线：`npm run build` + `npx tsc --noEmit` + `npm test`（86 过/0 败）。

**既定决策（grill 定案，三档共同）**：行 = 角色、列 = 系统（touch-point），阶段带移除；Object = Reference 投影（本档不做）；「自由改 task 连接顺序」所有档位必须可用；Fork/Join 真并行仅 Full 档。
- **execution 类型规则**（三档共同的产品语义，2026-11-23 用户定案）：录制产物 = `manual`（用户手动点击采集）；用户手动添加默认 = `manual`；Refine 时由 AI 逐 step 判定 `manual`/`automated`；用户可随时手动改。**本档不改动 execution 默认值的实现**（现状字段 optional、无默认）——如需在 Lite 档一并落地，追加「录制/手动添加默认写 `manual`」的小改动（recorder 与手动添加入口各一处 + 单测，约半天）。

**Phase 0 前置（必做）**：提交并真机验证 X6 画布三 change + formalize-reference（`docs/canvas-multilevel-verification-2026-11-22.md` 清单，reference 剩 7.4）。本档全部工作建立在它们之上。

## 1. 目标 / 不做

**目标**：Swimlane 视图从只读变为可真实编辑：行 = 角色标签、拖卡改归属、格内加 task、拖拽改连接顺序；编辑落盘为真实流程数据（影响执行/Instruction/Test）。

**不做**：空行/空列、整行整列拖拽重排、显式连线 UI、Object 节点、Fork/Join、lanes 主数据、坐标落盘、AI refine 联动（可选项见 §6）。

## 2. 数据模型

- `group` 新增可选 `actor?: string`（自由文本，最近祖先继承——完全复制 `targetSystem` 的既有模式）。落点：`engine/schema/src/schema.ts` group extend（~:383）。**必须显式声明**（Zod 默认 strip 未知键，漏声明会在保存/加载链路被洗掉——`targetSystem` 注释即前车之鉴）。
- 不升 schema 版本（additive 可选字段）。
- 行列仍由标签出现序推导：空行/空列天然不支持。

## 3. 推导层改造（`renderer/flow-graph.js`）

- `buildSwimlane`（:553）行推导：L1 阶段带 → **actor 标签去重（出现序）+『未标注』兜底行**；行内卡序保持执行序；分支兄弟带合并逻辑（03–05 带）随阶段带一并移除。
- 列推导不变（targetSystem + 未标注兜底）。
- 卡片 lane = 自身或最近祖先 group 的 actor 标签（与 targetSystem 同法）。
- 布局常量（:531–540）沿用；行语义变化不需要动坐标算法。

## 4. 交互（`renderer/app.js` 泳道分支 + `renderer/app.css`）

1. **行头/列头右键菜单**：重命名角色/系统 → 全量替换该行/列所有卡片的 `actor`/`targetSystem` 标签值（一次编辑整行生效，缓解拼写漂移）。
2. **卡片拖拽（X6 核心节点拖拽 + `embedding` 落点检测，见 §9）**：
   - 拖到目标行/列头或格 → 改写该卡所属 group 的 `actor`/`targetSystem`（语义回写；布局由数据重推导，无坐标落盘，自动吸附由重推导天然保证）；
   - 拖到同行另一卡的前/后 → 树内 reorder（改执行序）→ 连线随 `buildGraph` 自动更新。**这是本档的「自由改连接」实现：拖拽重排即改连接**。
3. **格内加 task**：格右键 → 复用现有「Add before / Add after / 分组」操作族，目标定位到该格对应的 group；新 group 继承该格的 actor/targetSystem 标签。
4. 分支目标修改：沿用现有 condition 编辑对话框。

## 5. 实施步骤

| # | 内容 | 主要文件 |
|---|---|---|
| 1 | schema：group.actor 字段 + 单测（含「Zod 不 strip」往返断言） | `engine/schema/src/schema.ts`、`tests/flow-authoring.test.mjs` |
| 2 | `buildSwimlane` 行推导改 actor + 用例更新（行=角色、未标注兜底、分支带移除） | `renderer/flow-graph.js`、`tests/swimlane-levels.test.mjs` |
| 3 | 泳道交互：行/列头菜单、卡片拖拽语义回写、格内加 task 挂接现有 group 操作 | `renderer/app.js`、`renderer/app.css` |
| 4 | 回归：回放 overlay、编号（仍按树位置，零影响）、Instruction/Test 不回归 | — |
| 5 | build + tsc + test 全绿；真机验证清单（见 §7） | — |

## 6. 验收标准

- 行 = 角色标签去重（出现序）+ 未标注兜底行；列不变。
- 拖卡到行/列 = 标签改写，保存重开仍在；Instruction/Test 同步反映新归属。
- 拖卡改序 = 执行序与 Process 连线变化，回放按新序执行。
- 格右键加 task 落在正确 group 且继承格标签。
- AI refine 不破坏 actor 标签（验证 Zod 声明生效；可选增强：refine 提示词加一句「保留 group 未知字段」）。
- 全量测试绿。

## 7. 真机验证清单

- [ ] 旧 Flow（无 actor）打开：单「未标注」行 + 现有列，不报错
- [ ] 拖卡跨行/跨列 → 保存 → 重开 → 归属仍在
- [ ] 拖卡改序 → 回放执行序一致
- [ ] 行头改名 → 整行卡片标签同步
- [ ] refine 后 actor 标签存活

## 8. 风险

- 同角色拼写漂移（"申请者"/"申请人" 两行）→ 行头改名全量替换缓解；无 id，治本要靠 Standard/Full 档的主数据。
- refine 重分组拆并 group 时 actor 丢失 → 可选提示词增强；属已声明的技术债。
- 全部增量是一次性投入，Full 档落地即废弃（已明示，用户接受）。

## 9. 画布引擎选型

结论：**继续用 X6 3.x，不换库**。对比与证据见 [画布技术选型对比](process-swimlane-canvas-selection-2026-11-23.md)。

- 本档只用两项 X6 能力，均已在现有包内、零新增依赖：核心节点拖拽（编辑模式下经 `interacting.nodeMovable` 按节点开启；现状是全局 `interacting: false`）与核心 `embedding`（格占位节点为父，`findParent` + 松手 `node:embedded`，一次落点即得目标行与列）。
- 术语澄清：X6 的 `Dnd` 插件是「从工具栏拖入新建节点」，不是移动现有节点；本档拖的是现有卡片，用不到它。
- 本档周期不因选型变化（1–1.5 周）。
