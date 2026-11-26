# Proposal

## Why

- **目录回答不了"新模块放哪"。** 顶层只有 `engine/`、`renderer/`、`src/` 三层：`src/` 平铺 18 个文件，混着窗口与浏览器标签页、录制会话、回放会话、Flow 持久化、Reference 附件、Pi/AI、rrweb 录屏、日志等约十类职能；`renderer/` 平铺 5 个文件。后续要加语音、替换泳道/画布组件时没有规则可循。
- **模块之间靠隐式耦合协作。** `src/main.ts` 2,747 行，其中 `registerIpc()` 一个函数约 1,480 行；28 个模块级变量被窗口、标签页、录制、回放、AI 各处共享。可复用的入口（开始录制、停止回放、更新 Flow……）只存在于 IPC handler 的闭包里，新的触发来源（如语音）只能再去改 `main.ts`。`renderer/app.js` 11,184 行（约 310 个顶层声明）、`renderer/bridge.js` 2,196 行共享全局作用域：`bridge.js` 靠运行时重新赋值 `app.js` 的 19 个顶层函数来替换实现，另包装 3 个渲染函数、挂 9 个全局钩子——"看到函数先查 `bridge.js` 是否覆盖了它"是现有的排障陷阱。
- **画布与面板编排揉在一起。** X6 的使用集中在 `app.js` 第 1086–2545 行，但面板编排、工具栏、级别切换、右键菜单、回放 overlay 与引擎调用交织，替换泳道/画布组件没有缝可下刀。
- **没有成文的编码规范，也没有工具守住。** 生产代码约 2,500 个具名函数/方法里只有约 440 个（17%）带方法级注释（`app.js` 7%、`flow-graph.js` 7%、`bridge.js` 15%）；仓库没有任何 lint；`CONTRIBUTING.md` 仍写着"没有测试脚本""只给非显然不变量写注释"。
- **样式是一个 8,466 行的单文件。** 1,185 条规则里 157 个选择器被重复声明，其中 126 个靠"后者覆盖前者"生效，60 个的两次声明相隔超过 500 行。
- **既有重构文档已落后于代码。** `docs/architecture-refactor-roadmap-2026-11.md`（11-17）写于 X6 画布、泳道视图、多级分组、Reference 正式化等 change 落地之前；泳道三档文档（11-23）写于泳道视图与多级分组落地之前。路线图的目录演进建议与泳道文档的现状描述都以当时的代码为基线，需要一份以当前代码为准的结构重构计划。

本 change 只做结构：不新增、不修改任何用户可见功能。IPC 通道名与载荷、错误消息文本、`window.flowlink` 形状、Flow schema、磁盘数据布局、`dist/` 产物布局全部不变。各项决定的依据与取舍见 `design.md`（2026-11-26 与用户逐项确认）。

## What Changes

- **顶层按运行时分层 + 职能子目录。** `engine/`（纯 TS）、`electron/`（原 `src/`：Electron 主进程 + preload）、`renderer/`（浏览器 UI）保留为顶层，因为三者运行环境、安全边界、构建方式不同；每层内按职能建子目录，域名单三层对齐。`openspec/`、`docs/` 是独立于运行时代码的管理目录，原地不动。"新增模块放哪"的查找规则写入 `AGENTS.md`。
- **`electron/` 主进程拆分。** `main.ts` 只做装配；浏览器标签页、录制会话、回放会话、Flow 仓储、Reference、AI、任务存储成为用工厂创建、依赖注入的协调器，状态归各自协调器所有；IPC handler 变薄为"参数校验 + 调用协调器"；IPC 通道名集中成 main 与 preload 共用的一份常量。
- **`renderer/` 模块化。** 保持经典脚本、不引入打包器或自定义协议；每个模块是 IIFE，只在 `window.FlowLinkUI` 命名空间上显式导出，加载顺序由 `index.html` 显式声明，模块在加载期解析并校验依赖。`app.js` 按功能区拆到 `core/`、`host/`、`tasks/`、`workspace/`、`recording/`、`ai/`、`shared-ui/` 与 `panels/<页签>/`；`bridge.js` 拆解为宿主实现与各功能区。
- **删除演示模式 mock。** `app.js` 里只在不经 Electron、直接用浏览器打开页面时才会执行的 mock（iframe 模拟页、`postMessage` 采集、快照桥、模拟录屏，约 800–1,000 行）删除；界面统一经 `UI.host` 调用宿主能力，"覆盖全局函数"的机制随之消失。**这是本 change 唯一有意的能力移除**：浏览器直接打开 `renderer/index.html` 的演示预览不再可用。
- **画布适配层。** 定义引擎无关的画布接口与场景模型，X6 收敛为 `renderer/panels/process/canvas/engines/` 下的唯一实现；面板编排、工具栏、菜单、回放 overlay 只依赖接口。
- **`engine/` 文件级拆分与依赖规则。** `schema.ts` 拆成 element / variable / step / flow / template / contract；`record.ts`、`run.ts` 只抽出外围函数，`record()` 与 `runFlowInBrowserContext()` 两个超长函数本体不动；包间依赖方向写成规则并由测试守住；各包 `index.ts` 的导出清单不变。
- **CSS 走读与按域拆分。** 先走读 `app.css`：可合并的合并，永远被覆盖的和可证明无用的删除；再按域拆分——基础样式留在 `renderer/styles/app.css`，业务样式进各域目录，`index.html` 按序加载。
- **编码规范与全量回填。** `AGENTS.md` 写入注释规范（生产代码的具名函数/方法必须有解释型 JSDoc；renderer JS 强制类型标签；名字承载描述）；存量约 2,100 个缺失注释在本 change 内按域分批补齐；做函数级与模块级命名整改。
- **强制手段与安全网。** 引入 ESLint：`no-undef` 作渲染层拆文件的安全网，jsdoc 规则守注释规范。动结构前先铺结构性基线：IPC 通道清单与 preload API 形状快照、engine 依赖边界与导出清单快照、JSDoc 覆盖率棘轮、CSS 计算样式快照对等。
- **`tests/` 归类。** 按被测域分目录，抽出公共 bundle helper。
- **文档。** 更新与本次改动直接相关的文档；根目录的 Pi 配置文档归入 `docs/`，`ui_prototype/` 归入 `docs/design/`；旧路线图移入 `docs/archive/`。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

行为契约不变，仅更新 requirement 正文中引用的源码路径：

- `renderer-ui`：「Process 标签页渲染语义图」中的"先于 app.js 加载"改为不绑定具体脚本文件；「步骤展平与事件对齐单一实现」中的 `renderer/flow-graph.js` 改为拆分后的 `renderer/panels/process/graph/flatten.js`。
- `ai-integration`：「生成把元素引用投影为去重库」中的 `src/ai-refine.ts` 改为 `electron/ai/ai-refine.ts`。

编码规范与目录查找规则属于实现约定，落在 `AGENTS.md`，不进 spec。

## Impact

- **目录**：`src/` → `electron/`（含职能子目录）；`renderer/app.js`、`renderer/bridge.js`、`renderer/flow-graph.js` 拆分消失；`renderer/app.css` 拆分；`engine/schema/src/schema.ts`、`engine/recorder/src/record.ts`、`engine/executor/src/run.ts` 抽出外围文件；`tests/` 分目录。
- **构建与配置**：`build.mjs`（入口与 external 字面量）、`package.json`（`lint` 脚本与 lint 相关 devDependencies；`test` 脚本改为显式匹配 `tests/` 下的测试文件）、`package-lock.json`、`tsconfig.json`（include）。
- **不变量**：IPC 通道（50 个 invoke、14 个事件）及其载荷、错误消息文本、`window.flowlink` 形状、Flow schema 与磁盘数据、`dist/` 产物清单与位置、`config/`、`process_landscape/`、`resources/` 的位置与读取方式、Electron 安全设置（`contextIsolation`、`nodeIntegration: false`、preload 白名单）。
- **文档**：`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`README-zh.md`、`docs/architecture.md`、`docs/technical-architecture.md`、`docs/response-map.md`、`CHANGELOG.md`；归位 `Pi integration configuration.md`、`ui_prototype/`；归档 `docs/architecture-refactor-roadmap-2026-11.md`。
- **测试**：现有 11 个测试文件移动并更新入口路径；其中 5 处读源码文本做断言的用例改指向新路径；新增 `tests/architecture/` 基线测试与 `tests/helpers/`。
- **执行方式**：按风险从低到高分 7 个阶段，每阶段末尾以及第 3、4 阶段内部的若干位置（共 12 个停点）停下，由用户真机验证并提交后再继续（见 `tasks.md`）。

## Out of Scope

- 任何功能的新增或修改：语音交互、泳道可编辑化（Lite/Standard/Full 三档）、画布引擎本身的替换、Workflow IR v3+、Proposal/diff、Process Studio、Run 状态与恢复、批量回放界面等，均不在本 change。本 change 只为它们准备结构落点。
- `record()`（约 1,570 行）与 `runFlowInBrowserContext()`（约 990 行）两个超长函数的内部拆分——没有任何自动化测试执行到它们，留作后续独立 change，并建议先建立带浏览器的自动化测试。
- 渲染层改用 ES Module、打包器、自定义协议或 TypeScript；渲染层 CSS 改用 `@layer`。
- 公开契约的改名：engine 各包 `index.ts` 的导出名、IPC 通道名、`window.flowlink.*` 形状、Flow JSON 字段、`index.html` 的 `id`/`data-*` 钩子。
- 新的行为级测试（协调器单元测试、录制/回放特征测试）。
- `config/`、`process_landscape/`、`resources/`、`scripts/`、`build.mjs`、`package.mjs` 的位置；`dist/` 布局与打包脚本行为。
- `tests/` 与构建脚本的注释回填（不强制）。
- `docs/archive/` 内历史文档的行号与路径；泳道三档计划与画布选型文档的方案内容（它们是未实施的功能计划与仍然有效的选型结论，只更新状态说明与路径引用）。
- OpenSpec 主 spec 的其他文字；`openspec/` 目录本身的位置。
