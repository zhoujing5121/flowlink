# Process 泳道画布技术选型对比（2026-11-23）

> 适用范围：Lite / Standard / Full 三档共同的「画布引擎」决策（[Lite](process-swimlane-lite-plan-2026-11-23.md) / [Standard](process-swimlane-standard-plan-2026-11-23.md) / [Full](process-swimlane-full-plan-2026-11-23.md)）。
> 起因：三档计划原文均为「X6 + 自定义开发」，希望评估是否有成熟开源产品可以「部分自定义」替代，以提高质量、缩短周期。
> 事实核实日期 2026-11-23：npm registry、GitHub API、各库官方文档/源码/许可原文、本仓库已装 `@antv/x6@3.1.8` 的类型定义与构建产物。未能核实的项集中在 §8。

## 0. 结论

1. **三档继续用 AntV X6 3.x（已装且为 npm 最新 3.1.8），实现方式从「X6 + 交互全自研」改为「X6 内置编辑插件 + 自定义语义层」。** X6 3.x 已把 Selection / Snapline / Dnd / Keyboard / Clipboard / History / Transform / Scroller 等插件并入主包，且已在现有 `dist/renderer-vendor.js` 中导出到 `window.__flowlinkX6`——零新增依赖；当前代码只用了 `Graph` + `Shape.HTML` + `MiniMap`。
2. **换库不会缩短周期。** 没有任何候选开箱提供「行 × 列」矩阵泳道（需求的核心）；最接近的 LogicFlow 泳道插件只覆盖单轴。换任何库都要重写现有画布引擎层（`renderer/app.js` 1086–2545，约 1,460 行），并重做尚未真机验证的画布功能。
3. **周期更新**：Lite 1–1.5 周（不变）；Standard 5–6.5 → **4.5–6 周**；Full 10–12.5 → **9.5–12.5 周**。开源红利的真实规模是「每档约 0.5 周 + 免费多出多选/快捷键/复制粘贴」，不是数量级——瓶颈不在画布引擎，而在数据模型与迁移、语义回写，以及 Full 档的执行器。
4. 备选与重评条件见 §7：React Flow 13 是「渲染层整体迁 React」时的首选，LogicFlow 是「需要标准单轴泳道」时的首选，两者都不是现在。

## 1. 选型必须满足的需求

| # | 需求 | 来源 |
|---|---|---|
| R1 | 矩阵泳道：行 = 角色、列 = 系统 touch-point；空行/空列增删；整行/整列拖拽重排 | 原始需求 + grill 定案 |
| R2 | 格 = 行 × 列交点；格内加 task | 原始需求 |
| R3 | 四级拖拽（行/列/格/task）+ 落点吸附高亮 | 原始需求 |
| R4 | 显式连线编辑：拖线建边、改接、删除、非法连接拒绝 | grill 定案（所有档必须可用） |
| R5 | 更多节点类型：Start/End、Decision、Fork/Join、Object | 概念图 |
| R6 | 富 HTML 任务卡（沿用现有卡片 DOM/CSS） | 现状 |
| R7 | 接入 vanilla 渲染层（无打包器、无 React；第三方库经 `src/renderer-vendor.ts` 打成全局变量） | 现状 |
| R8 | 许可无强制水印 | 产品要求 |
| R9 | 编辑基座：多选、快捷键、复制粘贴、撤销重做 | 编辑器的隐含预期 |
| R10 | 画布是数据的投影：布局由数据重推导，不落盘像素 | grill 定案 |

R10 决定了对比的口径：无论选哪个库，库层面的「几何落位」都不是事实源，拖拽/连线都必须桥接成语义写回——这部分在任何候选上都是定制工作。

## 2. 候选与核实事实（2026-11-23）

| 库 | 最新版（npm） | 许可 | 维护信号 | 一句话定位 |
|---|---|---|---|---|
| **AntV X6** | 3.1.8（2026-09-21；本仓库已装同版） | MIT | 6.7k★；最近 push 2026-10-20 | 蚂蚁 AntV 图编辑引擎；3.x 插件并入主包 |
| **React Flow**（`@xyflow/react`） | 13.0.2（2026-11-17） | MIT | 38.6k★；月下载约 6,000 万（官方博客）；v13 刚发布 | React 节点编辑器，节点即 React 组件 |
| **LogicFlow** | core 2.2.5 / extension 2.3.1（均 2026-07-30） | Apache-2.0 | 11.7k★；最近 push 与发版均停在 2026-07-30 | 滴滴流程图编辑框架；自带泳池/泳道插件 |
| **bpmn-js** | 18.33.1（2026-11-20） | 自定义（MIT 式 + 强制水印条款） | 9.5k★；成熟 | BPMN 2.0 建模器 |
| **maxGraph** | 0.25.2（2026-11-20） | Apache-2.0 | 仍为 0.x | mxGraph 的 TypeScript 继任者 |

关键事实（均来自官方文档/源码/许可原文）：

- **X6 3.x**：`@antv/x6-plugin-*`（selection / transform / scroller / keyboard / history / clipboard / snapline / dnd / minimap / stencil / export）全部并入 `@antv/x6`，用法不变（`graph.use(new X6.Snapline(...))`）。本仓库 `globalThis.__flowlinkX6 = { ...es_exports }`，构建产物中 `Dnd` / `Snapline` / `History` / `Clipboard` / `Selection` / `Keyboard` / `Transform` / `Scroller` / `Stencil` 类均已存在。
- **React Flow 13**：要求 React ≥ 18，**不再提供 UMD 包（仅 ESM）**；新增 `changeParentNode`（父子组移动）与 `useNode` / `useEdge` 局部订阅；撤销重做无内置（README 列的是社区 hook `useUndoable`）。
- **LogicFlow**：`@logicflow/extension` 提供 `PoolElements` 插件——泳池承载泳道、泳道承载业务节点，**拖拽/放置自动归属泳道**，泳道有「前/后插入」「删除」按钮，`direction: 'horizontal' | 'vertical'`。但官方架构文档明确：结构固定为 pool → lane → tasks、**不支持任意嵌套**；泳道不可折叠；`DynamicGroup` 与 `PoolElements` **同一画布只能二选一**；DynamicGroup / Pool / 旧 Group **三套分组栈并存**（旧 Group 已弃用），共享模型代码有已知 bug 类。
- **bpmn-js**：许可原文——「the bpmn.io project watermark … MUST NOT be removed or changed … must stay fully visible and not visually overlapped by other elements」。
- **maxGraph**：README 自述「currently under active development, with a few adjustments still required to match the behavior of mxGraph」，文档「work in progress」；功能表含 swimlane 布局、层级分组、撤销重做、框架无关。

看过但不进矩阵的：

| 库 | 原因 |
|---|---|
| JointJS（`@joint/core` 4.3.4，MPL-2.0） | 开源版只有核心绘图；选区、模板面板、历史、吸附线、剪贴板等编辑插件属商业版 JointJS+ |
| FlowGram.AI（字节，1.0.16，MIT） | 面向 AI 工作流的节点画布（固定/自由布局），未发现泳道容器语义 |
| GoJS、yFiles | 商业授权，非开源 |
| Rete.js、Drawflow、LiteGraph | 节点编辑器，无泳道/容器语义 |

## 3. 能力对照（相对本项目需求）

● 原生可用　◐ 有基座、仍需自定义　○ 无　† 依据长期公开资料，本次未逐条复核

| 需求 | X6 3.x | React Flow 13 | LogicFlow 2.x | bpmn-js | maxGraph 0.x |
|---|---|---|---|---|---|
| R1 行 × 列矩阵泳道 | ○ | ○ | ○（泳道仅单轴） | ○（lane 仅单轴） | ○ |
| R1 单轴泳道增删 + 拖入归属 | ◐ `embedding` | ◐ `parentId` / `extent` | ● | ● † | ◐ |
| R1 整行/列拖拽重排 | ◐ | ◐ | ◐（文档只有插入/删除） | ◐ | ◐ |
| R2 格内加 task | ◐ | ◐ | ◐ | ◐ | ◐ |
| R3 拖拽吸附 | ● Snapline + grid | ◐ 仅网格吸附 | ● † | ● † | ● † |
| R4 显式连线编辑 + 校验 | ● | ● | ● | ● † | ● † |
| R5 决策 / Fork / Join 节点 | ◐ 自定义节点 | ◐ 自定义节点 | ● BPMN 元素 | ● BPMN 元素 | ◐ |
| R6 富 HTML 任务卡 | ● `Shape.HTML`（已用） | ● React 组件 | ● `html` 节点 | ○ SVG，需自写渲染 | ◐ 文档未完备 |
| R7 vanilla 接入（无 React） | ● | ○ 必须 React ≥ 18 | ● | ● | ● |
| R8 无强制水印 | ● | ●（默认署名，可配置） | ● | ○ 水印必须可见 | ● |
| R9 多选 | ● Selection | ● | ● SelectionSelect | ● † | ● † |
| R9 快捷键 | ● Keyboard | ◐ | ● † | ● † | ● † |
| R9 复制粘贴 | ● Clipboard | ○ 自建 | ◐ 未核实 | ● † | ◐ 未核实 |
| R9 撤销重做 | ● History（本项目不用，见 §5） | ○ 自建 | ● † | ● † | ● |
| **从现状迁移的成本** | **0** | 高 | 高 | 很高 | 高 |

结论行只有三行是决定性的，且都已核实：**矩阵泳道（全部 ○）**、**框架约束（React Flow 必须 React）**、**迁移成本（X6 为 0，其余都要重写引擎层）**。许可一票否决 bpmn-js。

## 4. 逐个评估

### 4.1 X6 3.x —— 选中（三档一致）

- 已集成：画布三个 change 已把 Flow 视图、泳道视图、多级分组、MiniMap 迁到 X6；`renderer/flow-graph.js` 的纯数据推导与引擎无关，三档的推导层改造照旧。
- 编辑基座齐全且已在包内（清单见 §5）。
- 缺的是矩阵泳道语义层——这一点所有候选都缺。
- 注意：X6 没有现成「泳道容器」，行/列/格用自定义 HTML 节点 + `embedding` 表达；HTML 节点与 X6 在 Electron 下有过兼容坑（如 MiniMap 零尺寸产出 NaN 矩阵），插件接入须先冒烟。

### 4.2 React Flow 13 —— 备选（仅当渲染层整体迁 React）

- 优点：生态最大、节点即组件、v13 的性能与父子组改进；连线校验（`isValidConnection`）与重接（`edgesReconnectable`）能力齐全。
- 不选的理由：强制 React ≥ 18 + 仅 ESM → 要在约 9k 行 vanilla `app.js` 旁引入 React 岛与新的构建步骤，形成双范式；撤销、复制粘贴、对齐线都要自建；v13 发布仅一周；没有任何泳道能力。对当前需求净收益为零，迁移成本却最高。
- 重评触发：另立「渲染层框架现代化」决策时。

### 4.3 LogicFlow 2.x —— 最接近需求，但不选

- 它确实有原生泳道：Pool 插件解决「加行、拖卡入行、删行」——这是 X6 没有现成件的。`openspec/changes/refactor-process-canvas-x6/design.md` 排除 LogicFlow 的理由（「分组折叠已知问题」，针对旧 Group）已过时。
- 仍不选的四个原因：
  1. **只覆盖单轴。** 一个泳池只有一个方向；行（角色）用了泳道，列（系统）仍要全部自写——格、列的增删重排、二维吸附的工作量不变，只省掉约三分之一的泳道交互面。
  2. **迁移成本大于收益。** 现有引擎层约 1,460 行（Flow 视图、泳道视图、MiniMap、回放 overlay、下钻、双视图状态）要在新引擎上重写并重新真机验证，估 1.5–2 周；换来的原生泳道收益不到 0.5 周。
  3. **成熟度风险。** 官方架构文档自述三套分组栈并存、Pool 与 DynamicGroup 互斥、共享模型代码有已知 bug 类，并要求改动后对 pool 与 dynamic-group 页面做回归。
  4. **维护节奏放缓。** npm 与 GitHub 的最近发版/push 均停在 2026-07-30（近 4 个月）。
- 重评触发：Pool 支持二维（泳道嵌套或交叉）且分组栈收敛为一。

### 4.4 bpmn-js —— 排除

- 优点：BPMN 建模最成熟（池/泳道、网关、规则引擎、撤销栈）。
- 排除理由：① 许可强制保留 bpmn.io 水印且不得遮挡；② 模型是 BPMN XML，我们的执行模型（步骤数组 + 条件组 + 回跳；Full 档为显式边）要双向映射，自定义元素需自写 palette / rules / renderer / factory；③ SVG 渲染，现有 HTML 任务卡要重做；④ 泳道同样只有单轴。
- 适用条件：需求变成「标准 BPMN 建模与导入导出」。

### 4.5 maxGraph —— 观察名单

- 优点：mxGraph 血统、框架无关、内置撤销重做与分组折叠、许可干净。
- 不选的理由：仍是 0.x，官方自述未完全对齐 mxGraph 行为，文档未完成；HTML 节点能力弱；API 稳定性无承诺。
- 重评触发：发布 1.0 且 HTML 标签文档完备。

## 5. X6 内置能力的用法（按档）

现状：`new X6.Graph({ interacting: false, ... })`（`renderer/app.js` ~1174）——所有节点不可拖。

| 能力 | X6 提供（均已在包内） | Lite | Standard | Full |
|---|---|---|---|---|
| 节点拖拽 | 核心：`interacting.nodeMovable` 按 cell 判定 | ✓ | ✓ | ✓ |
| 吸附对齐 | `Snapline` 插件 + `grid` 选项 | — | ✓ | ✓ |
| 落点检测（卡 → 行/列/格） | 核心 `embedding`：`findParent`（bbox / center 等）+ `validate` + 拖拽经过高亮，松手触发 `node:embedded` | ✓ | ✓ | ✓ |
| 拖入新建 | `Dnd` 插件：工具栏拖 Task / Object / Fork / Join 到格 | — | ✓ | ✓ |
| 连线 | 核心 `connecting`（`validateConnection` / `validateMagnet` / `allowLoop` / `allowMulti` / `createEdge`）+ 边工具 `vertices` / `segments` / `source-arrowhead` / `target-arrowhead` / `button-remove` | — | ✓ | ✓ |
| 多选 | `Selection` 插件（框选、点选、多选） | — | ✓ | ✓ |
| 快捷键 | `Keyboard` 插件（Delete、Ctrl+Z/Y、Ctrl+C/V） | — | ✓ | ✓ |
| 复制粘贴 | `Clipboard` 插件（粘贴转为命令，经校验入口） | — | ✓ | ✓ |
| 撤销重做 | 命令层实现。**不启用 `History` 插件**：它记录的是画布 cell 变更，而画布每次编辑后由数据重推导重建，会污染历史 | — | ✓ | ✓ |
| 大图性能 | `Scroller` 的 `virtual: true`（3.x 新增虚拟渲染），按需 | — | 可选 | 可选 |

表达方式：格是父节点、task 是子节点（`embedding` 是单亲树）；行与列是带状节点，整行/整列拖拽 = 带状节点连同其格、卡片批量移动后回写 order。Lite 档没有实体格，用格占位节点做父节点，一次落点即得到目标行与列。

两条接线约定（三档相同）：

1. 画布只读投影：拖拽/连线操作一律翻译成语义写回（Lite = 标签/顺序改写；Standard / Full = Authoring 命令），随后由数据重推导重建画布；不在画布上保留「中间态」坐标。
2. 编辑态与回放态切换：`interacting` 按状态整体开关，回放/测试运行时画布只读。

## 6. 周期影响

| 档 | 原估 | 新估 | 变化来源 |
|---|---|---|---|
| Lite | 1–1.5 周 | 1–1.5 周（不变） | 只用到核心节点拖拽与 `embedding` 落点检测，本就不涉及插件接入 |
| Standard | 5–6.5 周 | **4.5–6 周** | 阶段 3「泳道编辑交互」1.5–2 → 1–1.5 周；多选/快捷键/复制粘贴由插件提供，不另计 |
| Full | 10–12.5 周 | **9.5–12.5 周** | 阶段 5「泳道全编辑 + Object + 连线」1.5 → 1–1.5 周 |

避免的成本（不换库的直接收益）：换任何库都要对等重写现有画布引擎层并重新真机验证，估 1.5–2 周，另加新引擎的学习与排错成本（React Flow 还有双范式成本）。

为什么红利只有这个量级：三档估时主要在数据模型与迁移、Authoring 命令与校验、AI 契约，以及 Full 档的执行器边图化与并行——这些与画布引擎无关；而所有候选都缺的「矩阵泳道语义层」正好是泳道工作里最定制化的部分。

画布之外的一个可选杠杆（未计入估时，执行会话在 Authoring 命令族落地时评估）：撤销重做的跨分区原子性可用 Immer 的 patches / inversePatches（`produceWithPatches`）实现——每个命令对整份 Flow 文档做一次 `produce`，撤销 = 应用逆向补丁。对 Full 档「Change Set / Undo-Redo 跨 Workflow/Process/View 三分区原子」尤其省力；不采用则手写各命令的逆操作。

## 7. 重新评估的触发条件

| 触发 | 届时首选 |
|---|---|
| 渲染层整体迁移到 React（独立的框架现代化决策，不属本次变更） | React Flow（或 Svelte Flow） |
| LogicFlow 的 Pool 支持二维（泳道嵌套/交叉）且三套分组栈收敛为一 | LogicFlow |
| maxGraph 发布 1.0 且 HTML 标签文档完备 | maxGraph |
| 需求变更为标准 BPMN 建模/导入导出 | bpmn-js（接受水印或另谈授权） |

## 8. 未核实与保留意见

- X6 插件在 Electron 45 + `foreignObject` HTML 节点下的实际手感未实测。已要求 Standard / Full 的交互阶段以「插件接入冒烟」开头，估时内含。
- React Flow 13 发布仅一周，后续补丁风险未知；社区撤销方案 `useUndoable` 未验证；默认署名可否关闭依据 `proOptions` 配置项，未实测。
- LogicFlow：泳道拖拽重排、自定义 HTML 节点在 Pool 内的表现、复制粘贴的具体选项未实测；Pool 插件较新。
- bpmn-js 的泳道方向与嵌套细节未逐一核实（许可条款已足以排除）。
- JointJS 开源/商业的功能划分来自公开资料摘要。
- 矩阵中带 † 的格子本次未逐条复核；不影响结论行（矩阵泳道、框架约束、许可、迁移成本均已核实）。

## 9. 来源

- X6 3.x 迁移指南：<https://x6.antv.antgroup.com/en/tutorial/update>
- X6 许可：<https://github.com/antvis/X6/blob/master/LICENSE>
- React Flow 13 发布说明：<https://xyflow.com/blog/react-flow-13-major-release>
- React Flow 属性定义（源码）：<https://github.com/xyflow/xyflow/blob/main/packages/react/src/container/ReactFlow/index.tsx>
- xyflow 节点类型（源码）：<https://github.com/xyflow/xyflow/blob/main/packages/system/src/types/nodes.ts>
- React Flow README：<https://github.com/xyflow/xyflow/blob/main/packages/react/README.md>
- LogicFlow 泳池泳道文档：<https://site.logic-flow.cn/tutorial/extension/pool>
- LogicFlow 扩展架构说明：<https://github.com/didi/LogicFlow/blob/master/packages/extension/ARCHITECTURE.md>
- LogicFlow 节点文档：<https://site.logic-flow.cn/tutorial/basic/node>
- LogicFlow README：<https://github.com/didi/LogicFlow>
- bpmn-js 许可：<https://github.com/bpmn-io/bpmn-js/blob/develop/LICENSE>
- maxGraph README：<https://github.com/maxGraph/maxGraph>
- maxGraph 许可：<https://github.com/maxGraph/maxGraph/blob/main/LICENSE>
- JointJS 许可说明：<https://www.jointjs.com/license>
- FlowGram.AI：<https://github.com/bytedance/flowgram.ai>
