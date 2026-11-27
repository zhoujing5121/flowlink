# Tasks

执行约定：按顺序实施；每个阶段末尾是停点——自动化验证全绿后停下，由用户真机验证并提交，确认后再进入下一阶段。第 3、4 阶段体量最大，内部另设停点（分别在 3.4、3.8 之后与 4.3、4.10、4.12 之后），规则相同：停之前先跑 `npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test`，真机范围是自上一停点以来各任务列出的验证项，不另加新内容。移动/改名、结构改动、注释、命名整改分开成不同的提交（见 `design.md`"提交纪律与推进方式"）。提交由用户主导，执行会话不提交。

## 0. 基线与工具（不改产品代码）

- [x] 0.1 ESLint 接入：新增 devDependencies `eslint`、`eslint-plugin-jsdoc`、`typescript-eslint`、`globals`（锁定小版本）与 `eslint.config.js`，范围按 design D12；新增 `npm run lint`。规则名与选项以所装版本为准。验证：`npm run lint` 可运行并输出统计；`git diff package-lock.json` 只含 lint 相关条目，没有 `@browser_use/pi` 相关条目变化；`npm run build` + `npx tsc --noEmit` + `npm test` 仍全绿；全程未执行 `npm dedupe`。
  - 执行记录（2026-11-26）：typescript-eslint 因项目 typescript@7 原生编译器无 JS API 而不可用（见 design D12 执行期修正），改为 `@babel/eslint-parser` + `@babel/core`；pi 相关 lockfile 条目内容逐字节比对一致。
- [x] 0.2 JSDoc 棘轮：jsdoc 规则以 `warn` 接入生产代码范围（`src/`、`engine/`（含 `engine/recorder/capture/capture.js`）、`renderer/`；`tests/` 与构建脚本豁免）；新增 `scripts/lint-budget.mjs` 与 `lint-budget.json`，`npm run lint` 末尾比对 jsdoc 违例数与预算。验证：预算设为当前实际值时通过；把预算调低 1 时失败。
  - 执行记录：当前基线违例 840（require-jsdoc 638、require-param 149、require-returns 53）；预算 840 通过、839 失败，实测确认。
- [x] 0.3 编码规范入文档：按 design D11 把注释、命名、类型标签、示例与禁改清单写入 `AGENTS.md`；`CONTRIBUTING.md` 更正"没有 lint、测试脚本"的过时描述，Style 段改为指向该规范并补上 `npm run lint`。验证：条文与 D11 一致，且与现有 Invariants 不冲突。
- [x] 0.4 engine 基线测试：新增 `tests/helpers/bundle.mjs`（唯一的 esbuild 打包辅助函数）与 `tests/architecture/engine-boundaries.test.mjs`、`engine-exports.test.mjs` + `snapshots/engine-exports.json`（design D3、D13）。验证：新增测试通过；临时在 `engine/resolver` 加一条对 `executor` 的导入时边界测试失败，还原后通过；快照记录五个包 `index.ts` 的当前导出名单。
  - 执行记录：破坏性验证通过（resolver→executor 边被拦截），已还原；快照值 schema=29 reference=21 resolver=35 recorder=57 executor=59。
- [x] 0.5 IPC 契约快照：`tests/architecture/ipc-contract.test.mjs` 从 `src/preload.ts` 提取 invoke 通道（50）、事件白名单（14）与 API 分组形状，与 `snapshots/ipc-channels.json` 比对。验证：测试通过；临时改一个通道字面量时测试失败。
  - 执行记录：50 invoke / 14 events 确认；改动通道字面量 → 失败，还原 → 通过。
- [x] 0.6 CSS 计算样式快照工具：`scripts/css-style-snapshot.mjs`（design D13）与使用说明；界面状态清单覆盖列表页、Profile、Design 的六个页签、AI 面板开与关、确认对话框、Test 运行态、Record 回放。验证：真机生成基线快照两次，同一状态的输出一致；基线保存在本地 `scratch-css-snapshot/baseline/`（不入库）。
  - 执行记录：真机两轮 capture 全部 11 个自动状态一致（compare 0 差异）；状态间确有差异（drawer display none→flex 等）；Test 运行态、Record 回放为 manual 状态（capture-current），基线待真机数据下补充。
- [ ] 0.7 "仅注释提交"校验脚本：`scripts/assert-comment-only.mjs <基线提交> <路径…>`，把基线与工作区的文件分别去掉注释和空白后比较。验证：对只改注释的文件报告一致；再改动一个标识符后报告不一致。
- [ ] 0.8 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机：应用启动、录制一段（导航 + 点击 + 输入）、回放一段，确认工具接入不影响运行。停点：用户提交。

## 1. 纯搬迁：`src/` → `electron/`

- [x] 1.1 主进程文件搬迁：`git mv` 按 design D1 落位（`store.ts` 同时改名 `task-store.ts`），只修改路径字面量——文件内相对导入说明符（含 `ai-takeover.ts` 嵌套 pi-ai 的 `../node_modules/…` 改为 `../../node_modules/…`、Pi worker 对 `perf`/`app-logger` 的引用）、`build.mjs` 的 entryPoints 与 external 字面量、`tsconfig.json` 的 include（`electron/**/*.ts`；并试纳入 `engine/**/*.ts`，零新增错误才纳入，否则保持现状并在 design D15 记录）。验证：`git diff --cached -M --stat` 全部显示为 rename，除导入说明符外无内容差异；`npm run build` 产物清单与搬迁前一致（`dist/main.js`、`preload.cjs`、`pi-agent-worker.js`、`renderer-vendor.js`、`renderer-vendor.css`、`rrweb-inject.js`、`rrweb-replay.css`）；`npx tsc --noEmit` 通过。
  - 执行记录（2026-11-27）：18 个文件全部 rename；内容改动仅 7 个文件的导入说明符；`engine/**/*.ts` 纳入 tsc 零新增错误，已保留在 include；`eslint.config.js` 顺带移除已失效的 `src/**` 模式；`rrweb-capture.ts` 一处注释里的旧路径同步。
  - 启动失败修正（2026-11-27）：嵌套 pi-ai 的 external 说明符按 D15 原处方改为 `../../` 后运行时无法解析（见 design D15 执行期修正）。新增 `electron/pi-ai-nested.ts` 再导出垫片（electron/ 根深度），ai-takeover.ts 改从垫片导入，external 字面量保持 `../node_modules/…`；产物说明符与搬迁前一致，真机启动验证通过（whenReady → shown → 引擎桥连接）。
- [x] 1.2 测试入口路径：更新 `tests/` 中的 bundle 入口、`import` 路径、源码文本读取路径，以及 IPC 契约测试的读取目标（`electron/preload.ts`）。验证：`npm test` 全绿且用例数不变（152）；IPC 快照文件未改动。
  - 执行记录：IPC 快照文件未改动且比对通过（现在从 `electron/preload.ts` 提取）；pi-knowledge 的"skills 只在生成入口传递"源码读取改指 `electron/main.ts`、`electron/ai/pi-agent.ts`、`electron/ai/pi-agent-worker.ts`。
- [x] 1.3 `tests/` 归类：按 design D14 把测试文件移入域目录；8 份复制的 bundle 辅助函数替换为 `tests/helpers/bundle.mjs`。验证：`npm test` 发现的用例数不变且全绿；`tests/` 下只有 helper 定义了 bundle 函数。
  - 执行记录：10 个测试文件按 D14 归位；8 份本地 bundle 函数全部替换为共享 helper（`after()` 里释放共享临时目录）；全仓只有 `tests/helpers/bundle.mjs` 定义 bundle 函数。
- [x] 1.4 `flow-graph.js` 整体移动到 `renderer/panels/process/graph/flow-graph.js`；`index.html` 的脚本路径与 `swimlane-levels` 测试入口同步。验证：整文件 rename；`npm test` 全绿；真机 Process 页签渲染与移动前一致。
  - 执行记录：整文件 rename（无内容差异）；`index.html` 与 `swimlane-levels`、`nested-grouping` 两个测试的 bundle 入口同步（真机项待停点验证）。
- [x] 1.5 `AGENTS.md` 路径同步：Start here 与 Implementation patterns 中的 `src/` 路径改为 `electron/` 下的新路径。验证：`AGENTS.md` 中不再有指向 `src/` 的路径（`engine/*/src/` 除外）。
- [ ] 1.6 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机冒烟：启动；Pi 问答一次（worker 与嵌套 pi-ai 路径）；录制一段含新开标签页的流程并回放（`capture.js`、rrweb 注入）；Record 页签回放录屏；AI Continue 一次。停点：用户提交（搬迁与路径修改为一个提交，`tests/` 与 `flow-graph.js` 归类为另一个提交）。
  - 自动化部分（2026-11-27）：build 产物清单一致（12 项 + `rrweb-replay.css`）；tsc 通过；lint 840=预算；test 159 用例全绿（与搬迁前一致）。真机冒烟与提交待用户。

## 2. engine：文件级拆分与注释

- [x] 2.1 `schema.ts` 拆分：按 design D9 拆出 `element.ts`、`variable.ts`、`step.ts`、`flow.ts`、`template.ts`、`contract.ts`；`schema.ts` 保留为再导出桶。验证：engine 导出清单快照测试通过；现有 `../../schema/src/schema.js` 深层导入无需改动；`npm test` 全绿。
  - 执行记录（2026-11-27）：与 D9 行号映射的唯一偏差是 `SCHEMA_VERSION` 落在 `flow.ts`（它是 Flow 的版本契约、被 FlowSchema 与 io.ts 使用）而非 element.ts；深层导入路径未变，快照与 159 用例全绿。
- [x] 2.2 recorder 与 executor 的外围函数抽出：新建 `recording-labels.ts`、`recording-stability.ts`、`run-evidence.ts`、`run-support.ts`；`record()` 与 `runFlowInBrowserContext()` 本体不动，原文件对抽出的符号再导出。验证：导出清单快照通过；两个超长函数的函数体文本与拆分前逐字节一致；`npx tsc --noEmit` 与 `npm test` 全绿。
  - 执行记录（2026-11-27）：`STABLE_FRAMES`/`MAX_SETTLE_MS` 随唯一使用方迁入 recording-stability.ts；record.js 仅再导出既有导出符号 `applyRecordingLabels`（其余原本是模块私有，不新增导出，保持 record.js 导出面不变）；`safePageUrl` 由 run.js 再导出。超长函数体经 git diff hunk 区间与 HEAD 函数体区间求交验证：record()（HEAD 175–1763）与 runFlowInBrowserContext()（HEAD 291–1276）零触碰。
- [x] 2.3 engine 注释回填：按包分批（schema 与 reference、resolver、recorder 与 `capture.js`、executor），每个具名函数/方法补解释型 JSDoc，每个文件补文件头（design D11）。每批一个仅注释提交。验证：每批经 `scripts/assert-comment-only.mjs` 校验通过；该批的 jsdoc 违例数归零并同步下调 `lint-budget.json`；`npm test` 全绿。
  - 执行记录（2026-11-27）：四批全部完成（schema+reference 13、resolver 14、recorder+capture.js 84、executor 54），engine 违例归零（总量 840→675，余量属 electron/renderer，分别在 3.9/4.13 处理）。每批经 assert-comment-only 校验通过；`lint-budget.json` 840→827→813→729→675 逐批下调；每批跑 `npm test` 全绿。
  - 工具增强：`assert-comment-only.mjs` 支持 `index` 基线（对照暂存区），供结构改动已暂存、未提交时的批次校验（已在文件头注明）。
  - 提交方式说明：由于 2.1/2.2 的结构改动与注释批次发生在同批文件且尚未提交，用户提交时可按"结构改动（新文件与函数搬移）"与"注释回填"分开（git 按文件拆分即可近似满足：结构 = 六个新 schema 文件 + 四个抽取文件 + schema.ts/record.ts/run.ts 的结构部分；注释 = 其余改动）。若嫌拆分过细，合并为一个"engine 结构与注释"提交并在说明中注明亦可接受，但注释与后续 2.4 的命名整改必须分开提交。
- [x] 2.4 engine 命名整改：函数级与模块级名字按 design D11 整改，不动各包 `index.ts` 的导出名。验证：导出清单快照通过；`npm run lint` 无报错；`npm test` 全绿；"旧名 → 新名"清单写进提交说明。
  - 执行记录（2026-11-27）：全量审计 engine 五包的模块级/函数级名字后，仅一处违例——record.ts 的 `newURLSafeHost`（"URLSafe"暗示 URL 编码，实际是取 URL 小写 host）与冗余别名 `const URLSafeHost = newURLSafeHost`。改名：`newURLSafeHost` → `hostOfUrl`，别名删除，唯一调用点同步（函数模块私有，无外部引用）。其余短名（clamp/round2/slug/factsOf 等）均见名知义，判合规。导出快照、tsc、lint（675=预算）、159 用例全绿。
- [ ] 2.5 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机：录制一段多标签页流程（含输入与下拉）并回放；前缀回放后做一次分组重录。停点：用户提交。
  - 自动化部分（2026-11-27）：build/tsc/lint/test 全绿。真机待用户；提交待用户（命名整改单独提交，附旧名→新名清单：`newURLSafeHost`/`URLSafeHost` → `hostOfUrl`）。

## 3. electron：主进程拆分

- [ ] 3.1 通道常量：新增 `electron/ipc/channels.ts`；`preload.ts` 与 `main.ts` 的 `ipcMain.handle`、`webContents.send`、`ipcRenderer.invoke`、事件白名单改用常量；IPC 契约测试改为从常量取清单并比对同一份快照。验证：快照测试通过（50 个 invoke、14 个事件不变）；`electron/` 下不再有字符串字面量形式的通道名。
- [ ] 3.2 shell：抽出 `shell/startup-env.ts`（模块加载期副作用，作为 `main.ts` 的第一条 import）与 `shell/main-window.ts`。验证：真机日志目录与日志文件照常生成，启动计时日志仍在；窗口创建与初始页面加载行为不变。
- [ ] 3.3 BrowserTabs：`browser/browser-tabs.ts` 协调器（函数体原样搬运，状态归协调器），`browser:*` handler 改为调用协调器；对录制状态的读写经 `hooks` 注入。验证：IPC 快照通过；真机：新建/切换/关闭标签页、地址栏导航、前进/后退/刷新、窗口缩放时原生视图跟随、确认框出现时视图隐藏并在关闭后恢复、`browser:restart` 在录制中、回放中、空闲三种情况下的行为与现状一致。
- [ ] 3.4 RecordingCoordinator：`recording/recording-coordinator.ts` 吸收 design D4 列出的录制逻辑，`recording:start`、`recording:stop` 与导航类 handler 中的录制事件记录改为调用协调器。验证：IPC 快照通过；真机：录制启动与停止、启动过程中停止、空录制取消且不产生录制、录制中新开标签页被采集、录制中地址栏导航被记为步骤、`discard` 时临时目录被清理。停点：停下，由用户真机验证并提交后再继续。
- [ ] 3.5 PlaybackCoordinator 与 AI 接管编排：`playback/playback-coordinator.ts`、`ai-continue.ts`、`takeover-evidence.ts`。验证：IPC 快照通过；真机：Test 成功与失败、运行中停止、人工确认步骤的暂停与继续（过期 token 被拒）、前缀回放、AI Continue 单步续跑与两败即停。
- [ ] 3.6 Flow 仓储：`flow/flow-repository.ts`、`flow-pending.ts`、`recording-files.ts`、`artifact-crops.ts`。验证：IPC 快照通过；真机：Instruction 编辑落盘（版本递增并留 `.bak`）、Refine 生成后 pending 的 Confirm 与 Discard、`baseVersion` 不符时 Confirm 被拒并提示重新生成、删除录制与删除任务的文件级联清理、Instruction 证据截图可显示。
- [ ] 3.7 reference、tasks、ai、rrweb 的编排：`reference/reference-files.ts` 与 `reference-validation.ts`、`tasks/process-landscape.ts`、`ai/flow-generation.ts`（`pi:generateFlow`、`pi:repairFlow` 的编排）与 `ai/repair-evidence.ts`、`rrweb/rrweb-reader.ts`。验证：IPC 快照通过；真机：Reference 文件上传、覆盖、删除与 Download，Service Level 级联，Refine 生成，接管后的修复回跑，Record 页签加载录屏。
- [ ] 3.8 IPC 层拆分：`registerIpc()` 拆成 `ipc/register-<域>.ts`，每个 handler 只剩参数校验与调用协调器；`main.ts` 只剩装配；`pi-knowledge` 中"skills 只在生成入口传递"的源码断言改为同时检查 `ai/flow-generation.ts` 与 `ipc/register-ai.ts`，断言意图不变。验证：IPC 快照通过；`main.ts` 不含业务逻辑；拆分前后 `electron/` 内 `throw new Error(…)` 的消息字面量集合一致；`npm test` 全绿。停点：停下，由用户真机验证并提交后再继续。
- [ ] 3.9 electron 注释回填：分批进行（ai；recording、playback、browser；flow、reference、tasks、rrweb、infra、shell、ipc、preload），每个具名函数/方法补解释型 JSDoc，每个文件补文件头。验证：每批经仅注释校验；违例数归零并下调预算；`npm run build` + `npx tsc --noEmit` + `npm test` 全绿。
- [ ] 3.10 electron 命名整改：函数级与模块级名字按 design D11 整改。验证：IPC 快照通过（通道名与 preload 形状不变）；`npm run lint` 与 `npx tsc --noEmit` 无报错；`npm test` 全绿；"旧名 → 新名"清单写进提交说明。
- [ ] 3.11 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机全链路：任务创建与保存 → 录制 → 各页签分析 → Test（含人工确认与 AI Continue）→ Refine 与 pending 决议 → Reference 附件 → 删除录制与任务；另验证应用退出时录制被中断、Pi worker 被回收。停点：用户提交。

## 4. renderer：拆分

- [ ] 4.1 core、shared-ui、host 骨架：`core/namespace.js`（`window.FlowLinkUI` 与 `UI.require`）、`core/dom.js`、`core/state.js`、`core/events.js`、`core/format.js`；`shared-ui/` 各文件；`host/ipc.js`、`host/host-api.js`、`host/electron-host.js`（矩形上报、观察器、事件订阅）；`index.html` 的脚本清单同步。验证：`npm run lint` 对新增模块无 `no-undef` 报错；真机全功能冒烟无回归；`window.flowlink` 与 vendor 全局的边界断言在 4.12 启用。
- [ ] 4.2 删除演示模式 mock：按 design D7 的删除范围执行；`bridge.js` 中对应的 Electron 实现搬入 `app.js` 原函数位置替换 mock 函数体，其中的 IPC 调用改走 `UI.host`；删除 `bridge.js` 里对 `app.js` 顶层函数的覆盖赋值；去掉对 `renderAIPanel` 等渲染函数的包装，改用 `UI.events.emit('workspace:rendered')`。验证：`renderer/` 下不再有对 `app.js` 顶层函数的重新赋值；不再出现 `embeddedBrowserHTML`、`embeddedSnapshotBridge`、`receiveRecordingSnapshot`、`flowlink-snapshot`、`local://procurement`、`showGuide` 及页面模型的 `route`/`frame` 字段；真机：录制启停、地址栏导航、前进后退、新开/切换/关闭标签页、工作区确认框、AI 面板开合后原生视图位置正确。
- [ ] 4.3 tasks、workspace、recording：按 design D6 落位。验证：真机：任务列表的筛选、搜索、分页；新建与保存 Profile；Service Level 级联；打开与关闭抽屉；工作区分栏拖拽；录制全流程；分组重录与加节点；素材列表选择与 Refine；删除录制。停点：停下，由用户真机验证并提交后再继续。
- [ ] 4.4 graph 拆分：`flow-graph.js` 拆为 flatten、numbering、graph-model、swimlane-model、layout，导出到 `UI.panels.process.graph`（六个函数名不变），移除 `window.FlowGraph` 全局。验证：`swimlane-levels` 测试改用新入口后全绿；真机 Process 页签渲染与拆分前一致。
- [ ] 4.5 画布适配层：`canvas/canvas-api.js`、`scene.js`、`node-views.js`、`engines/x6.js`（design D8）。验证：`window.__flowlinkX6` 只出现在 `engines/x6.js`；面板、工具栏、菜单、overlay 代码中不出现 X6 的类型与实例；真机：Flow 与 Swimlane 切换、级别切换、下钻与返回、缩放与 fit、MiniMap、右键菜单定位、回放 overlay、Expand 开关、vendor 缺失时的明确报错。
- [ ] 4.6 panels/process：`process-panel.js`、`process-model.js`、`process-editing.js`。验证：真机：组的增删改移与并入下一组、手动步骤编辑器、步骤菜单的全部操作、条件分支目标编辑；编辑后 Flow 落盘且重新打开保持。
- [ ] 4.7 panels/instruction：`instruction-panel.js`、`instruction-fields.js`、`instruction-persist.js`。验证：真机：label 内联编辑与清空恢复默认措辞、技术抽屉字段编辑、`targetSystem` 标签编辑、执行方式切换、未保存编辑在切换页签时冲盘、校验失败时行内报错并回滚、密码值保持掩码。
- [ ] 4.8 panels/reference 与 panels/metric。验证：真机：Reference 表格、对象编辑对话框、文件上传/覆盖/删除、点击活动跳转到 Process 并高亮、Metric 偏好保存。
- [ ] 4.9 panels/test：`test-panel.js`、`run-controller.js`（吸收 `bridge.js` 中 Test 运行、AI Continue、辅助循环、修复回跑的逻辑）。创建该目录的同时把 `package.json` 的 `test` 脚本改为显式匹配 `tests/**/*.test.mjs` 与 `tests/**/*.test.ts`（design D1、D15）。验证：`npm test` 只执行 `tests/` 下的测试文件，用例数与 4.8 之后一致；真机：Test 运行与进度展示、停止、Analyze last failure、AI Continue 辅助循环、修复回跑、从任务流列表启动 Run、Test 运行过程中编辑被禁止、分支跳过的步骤显示为 Skipped。
- [ ] 4.10 panels/record：`record-panel.js`、`session-player.js`、`player-diagnostics.js`。验证：真机：录屏回放的播放、暂停、时间轴拖动、标签页视角切换；截图墙与放大；回放诊断报告可复制。停点：停下，由用户真机验证并提交后再继续。
- [ ] 4.11 ai：`ai-pane.js`、`ai-quick-actions.js`、`ai-mentions.js`、`ai-advice.js`、`ai-generation.js`、`pending-update.js`。验证：真机：快捷动作条按需出现、@ 提及、Refine 表单与 chips、建议问答与停止、pending 的 Confirm 与 Discard、聊天附件只存 id 与名称。
- [ ] 4.12 入口收口：删除 `app.js` 与 `bridge.js`，新增 `boot.js`；全部 `legacy-global` 声明清零；启用 `tests/architecture/renderer-structure.test.mjs`（加载清单、`@requires` 顺序、`window.flowlink` 与 vendor 全局的边界、无 `legacy-global`）；`flow-authoring` 中读 `app.js` 源码文本的断言改指向新模块。验证：结构测试通过；`renderer/` 下无 `app.js`、`bridge.js`；`index.html` 中每个模块恰好出现一次；`npm test` 全绿；真机全功能走查无回归。停点：停下，由用户真机验证并提交后再继续。
- [ ] 4.13 renderer 注释回填：分批进行（core、host、shared-ui；tasks、workspace、recording；panels/process 含 graph 与 canvas；panels 其余；ai；boot），每个具名函数/方法补解释型 JSDoc 并带类型标签，每个文件补文件头。验证：每批经仅注释校验；违例数归零并下调预算；`npm run lint` 与 `npm test` 全绿。
- [ ] 4.14 renderer 命名整改：函数级与模块级名字按 design D11 整改（如 `$` 改为表达"按 id 取元素"的名字），泛称参数由 `@param` 说明。验证：`npm run lint` 无报错；`index.html` 的 `id` 与 `data-*` 钩子清单与整改前一致；真机全功能走查。
- [ ] 4.15 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机全功能走查（覆盖 4.1–4.14 各项）。停点：用户提交。

## 5. CSS：走读、合并、删除、按域拆分

- [ ] 5.1 走读报告：静态分析（重复声明、永远被覆盖的声明、疑似无用选择器、跨域覆盖关系）加人工复核，产出三份清单——可合并或删除、疑似无用（待确认）、跨域覆盖约束。验证：清单交用户过目并确认删除范围后才继续。
- [ ] 5.2 合并与删除：执行确认后的清单（只做可证明等价的合并，不搬动保留声明的位置），每批修改后跑计算样式快照对等。验证：全部界面状态的快照与基线一致，出现的差异都能对应到被删除规则的预期消失且经用户确认；真机抽查列表页、Design 各页签、对话框。
- [ ] 5.3 按域拆分：基础样式 → `renderer/styles/app.css`；业务样式 → 各域目录（文件名与目录同名）；`index.html` 的 `<link>` 顺序按覆盖约束排序；残留的跨域覆盖放入最后加载的 `styles/overrides.css`。验证：快照对等；`<link>` 顺序满足走读得出的覆盖约束；每个业务域目录都有对应样式文件。
- [ ] 5.4 收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿。真机视觉走查：列表页、Profile、Design 六个页签、AI 面板开与关、各对话框、Test 运行态、Record 回放、泳道与流程图切换、窗口缩放与最大化。停点：用户提交。

## 6. 收尾

- [ ] 6.1 JSDoc 预算归零：`lint-budget.json` 归零，jsdoc 规则由 `warn` 改为 `error`，移除预算脚本与预算文件。验证：`npm run lint` 零警告零错误；临时删掉任一 JSDoc 后 lint 失败。
- [ ] 6.2 文档更新：按 design D16 更新 `AGENTS.md`（目录表、新增模块查找规则、依赖方向、Start here、Implementation patterns、OpenSpec 校验命令写法）、`CONTRIBUTING.md`、`README.md`、`README-zh.md`、`docs/architecture.md`、`docs/technical-architecture.md`、`docs/response-map.md`、`CHANGELOG.md`。验证：文档中出现的源码路径在仓库里全部存在；README 的目录树与实际一致；`AGENTS.md` 里的校验命令可实际运行。
- [ ] 6.3 文档归位与归档：`Pi integration configuration.md` → `docs/pi-configuration.md`；`ui_prototype/` → `docs/design/ui-prototype/`；`docs/architecture-refactor-roadmap-2026-11.md` → `docs/archive/` 并写归档说明；泳道三档计划与画布选型文档加状态说明并更新路径引用。验证：移动在 `git status` 中显示为 rename；仓库根目录只剩运行时、构建与管理所需条目；被改动文档内的相对链接有效。
- [ ] 6.4 打包验证：`npm run package`。验证：打包产物可启动，并在打包形态下录制与回放各跑一次（`capture.js`、rrweb 注入、vendor 脚本、`config/` 读取均正常）。
- [ ] 6.5 最终收尾验证：`npm run build` + `npx tsc --noEmit` + `npm run lint` + `npm test` 全绿，`openspec validate refactor-module-decoupling-and-layout --type change` 通过；真机按 `AGENTS.md` 的最小场景清单全量走查。验证：用户确认。归档由用户触发。
