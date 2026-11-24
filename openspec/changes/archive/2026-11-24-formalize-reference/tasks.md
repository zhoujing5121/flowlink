# Tasks

## 1. engine/reference 共享包

- [x] 1.1 建 `engine/reference/` 包骨架（tsconfig/package 引用对齐既有 engine 包），实现 `type-catalog.ts`（封闭类型目录 + 显示映射），验证：`npx tsc --noEmit` 通过且 catalog 单测（枚举封闭、映射唯一）通过
- [x] 1.2 实现 `labels.ts` label 启发式（证据优先级 label>placeholder>aria-label>name>类型语义兜底；成对日期 -开始/-结束；同名序号去重；兜底业务化措辞），验证：新增 node:test 覆盖成对日期/无证据兜底/去重三类场景并通过
- [x] 1.3 实现 `expression.ts` 安全表达式子集（tokenizer + Pratt parser + 求值器；日期/文本函数白名单；按 label 引用对象；静态校验：语法/未知名/循环依赖，错误带位置；无 eval/new Function），验证：node:test 覆盖合法求值、语法错误、循环引用、未知引用并通过
- [x] 1.4 实现 `validate.ts` 校验求值器（输入对象集 + 用户值表 → 违规列表 + 解析后值表：公式求值、大小写转换、非必填空串、条件必填），验证：node:test 覆盖必填缺失、格式/正负违规、公式求值、空串填充、多违规一次性收集并通过

## 2. engine/schema v3 契约与迁移

- [x] 2.1 扩展 `VariableSchema`（`label`/新 `type` 枚举（引 catalog）/`required`/`validation`/`activities`）与 `flow.referenceFiles`（相对工件路径防逃逸契约），`SCHEMA_VERSION` 升 3，验证：schema 单测覆盖未声明字段剥离与新字段往返
- [x] 2.2 `migrateFlow` 增加 v2→v3（类型映射 `text`/`email`/`number` 规则、label 用 `labels.ts` 回填），验证：迁移单测覆盖 v1/v2 旧 Flow 升 v3 后步骤与模板键逐字节不变、email 迁移带格式预设
- [x] 2.3 新增 flow-schema 相关永久回归测试文件（对齐 tests/ 既有 node:test 风格），验证：`npm test` 全绿

## 3. engine/recorder 录制端 label

- [x] 3.1 `record.ts` 变量抽取处（`url_N`/`input_N`/`select_N`/`file_N`/`password`）接入 `labels.ts` 产出 label（证据从 ElementRef observed 取），机器键与模板语义不变，验证：录制单测断言新变量携带非机器风格 label 且模板值仍为 `{{原机器键}}`
- [x] 3.2 录制回归：既有录制相关 node:test 全部通过（`npm test`），无步骤结构变化

## 4. 主进程 IPC 与回放闸门

- [x] 4.1 `flow:updateVariables` 扩展回写全部新字段并保持版本递增 + `.bak`，验证：IPC handler 单测/手测一次改 label+required+validation 落盘往返
- [x] 4.2 回放启动 handler 接入 `validate.ts` 闸门：有违规以结构化错误拒绝启动（含对象 label、规则、原因列表），无违规把解析后值表传 executor；executor 未知机器键模板引用仍拒绝，验证：闸门集成测试覆盖必填阻断与空串放行两条路径
- [x] 4.3 新增 `flow:addReferenceFile` / `flow:removeReferenceFile` IPC（sanitizeSegment 命名、写入 `artifacts/<recordingId>/references/`、元数据入 `flow.referenceFiles`、版本递增），验证：单测覆盖写入/删除往返与路径逃逸拒绝
- [x] 4.4 preload `window.flowlink.reference.*` 暴露 catalog/单对象校验/全量校验/文件 IPC（窄 API、无 Node 泄漏），验证：渲染层可调用且 `npx tsc --noEmit` 通过

## 5. AI refine 命名契约

- [x] 5.1 `mergeVariables` 支持模型 `variableLabels`（未知机器键整次拒绝、非空 label 覆盖），验证：node:test 覆盖 label 覆盖、未知键拒绝、其余元数据按源保留
- [x] 5.2 `config/prompts.json` systemPrompt 与 autoSanitize/refine 模板：参数保留条款改为「机器键不可变 + 不得内联值 + 输出 variableLabels（语言随源、动词短语、成对区间后缀）」，验证：prompts 校验单测（模板占位符完整性）通过
- [x] 5.3 生成后置守卫扩展（variableLabels 未知键拒绝路径与现有未知变量同一报错面），验证：node:test 覆盖拒绝路径

## 6. 渲染层 Reference 页

- [x] 6.1 `renderer/index.html` 表格模板改列（Object/类型映射/值/必填/校验摘要/活动）与编辑对话框扩展（label 去重、类型选择、必填、校验编辑器、活动多选），`renderer/app.css` 适配横向滚动，验证：手动打开 Reference 页呈现新列
- [x] 6.2 `renderer/app.js`：`hydrateReferenceVariables`/`persistReferenceVariables` 往返新字段；Object 列只编辑 label（机器键不可见不可改）；类型列走 catalog 显示映射；活动选项来自当前 Flow 顶层分组（无分组显示整段录制名），验证：编辑一个对象后重开页面字段保持
- [x] 6.3 即时校验：对话框表达式编辑经 preload 校验 IPC 即时报错并阻止保存；行级违规摘要，验证：输入非法公式见到定位报错且无法保存
- [x] 6.4 文件行持久化：上传走 `flow:addReferenceFile`（accept 加 `.docx`）、删除走对应 IPC、重启后文件行仍在可下载；自动导出 .xls/.md 保持现状，验证：上传-重启-下载往返
- [x] 6.5 回放启动被闸门拒绝时在 UI 一次性列出全部违规（对象 label + 规则 + 原因），验证：构造必填缺失启动回放见到完整清单

## 7. 文档与验证收尾

- [x] 7.1 更新 `docs/architecture.md` Reference 一节（对象模型、类型映射、校验闸门、文件持久化、AI label 契约），验证：文档与实现行为一致
- [x] 7.2 运行 `npm test`：全部新旧 node:test 套件通过
- [x] 7.3 运行 `npm run build` 与 `npx tsc --noEmit`，两者零错误
- [ ] 7.4 真机验证：录制含日期区间/多输入的流程 → 检查 Reference 页业务命名与新列；编辑校验/必填/活动；上传 .docx 重启验证；必填缺失阻断回放与非必填空串放行各验一次；AI refine 后 variableLabels 生效

## 8. 修订轮（2026-11-23 真机反馈）

- [x] 8.1 对话框布局：`.reference-dialog` 480px → 约 720px（`max-width: calc(100vw - 48px)`、`max-height: 90vh`、内容滚动），表单按「基本（两列网格）/ 填写规则 / 活动关联 / 高级」分区重构，验证：新建与编辑对话框在常规与窄窗口下布局正常、无挤压错乱
- [x] 8.2 `engine/reference` 新增 `presets.ts`（预设 ↔ validation 结构编译/反编译：大小写/格式/正负/日期自动计算「今天±N 天」/句子式条件必填）与 `describe.ts`（规则 → 中文业务短句，反编译失败标记「自定义规则」），验证：node:test 覆盖编译、反编译、往返等价与摘要短语
- [x] 8.3 编辑对话框友好化：默认视图只呈现业务预设控件（必填开关、大小写、格式、正负、日期自动计算预设带 N 数字输入、句子式条件必填「当『某对象』已填写时」下拉），自定义正则与原始条件/公式表达式移入默认折叠的高级区（保留即时校验与保存阻断）；表格校验列与回放违规文案改用 describe 摘要，验证：手动走查默认视图无技术词、高级区功能不回退、违规文案为业务短句
- [x] 8.4 Refine 活动默认关联：新材料落盘前 `deriveActivities`（步骤模板使用证据 → L1 分组 id，多处即多选）并清除自源继承的过期分组 id；`mergeVariables` 扩展 variableActivities（未知机器键整次拒绝、未知分组 id 剔除、建议仅填充无使用证据的变量）；prompts.json 增 variableActivities 输出指引，验证：node:test 覆盖证据推导/AI 填充/证据优先/未知键拒绝 + prompts 占位符校验
- [x] 8.5 回归收尾：`npm test`、`npm run build`、`npx tsc --noEmit` 全绿；真机复验（对话框布局、预设视图、Refine 后活动默认关联）留用户

## 9. 修订轮 2（2026-11-23 二次真机反馈）

- [x] 9.1 类型显示映射 `url` 显示名「地址」→「网址」（type-catalog 及全部引用与测试断言同步），验证：类型下拉与类型列均显示「网址」，`npm test` 通过
- [x] 9.2 日期自动计算预设（复修，2026-11-23 四次反馈定稿）：标签「日期自动计算」单独一行；下一行下拉框、条件显示的 N 输入框与「天」同行排列；N 输入框与「天」仅在「自动填：今天 ± N 天」时显示（手动填写/今天/自定义均隐藏）；先在真实渲染环境复现「手动填写仍显示输入框」的显隐缺陷再修，验证：harness 或真机逐一切换选项检查显隐与同行布局
- [x] 9.3 对话框滚动条去重：仅保留最外层滚动条（移除内层区域 overflow/max-height），验证：内容超高的对话框只见一条滚动条且各分区完整可达
- [x] 9.4 勾选框与文本同行：必填开关与活动关联选项改为横排 inline 布局，验证：勾选框与文字同行显示
- [x] 9.5 回归：`npm test`、`npm run build`、`npx tsc --noEmit` 全绿
- [x] 9.6 9.2 复修后回归与复验：`npm test` / `npm run build` / `npx tsc --noEmit` 全绿；重建构建后真机复验日期预设显隐与对齐

## 10. 修订轮 3（2026-11-23 新需求：Add 直开与文件类值附件）

- [x] 10.1 Reference 页 Add 按钮直接打开对象编辑对话框（移除「Add variable / Upload files」中间选择弹窗及其模板与事件；独立多文件上传入口收敛为「新建文件类对象 + 上传控件」），验证：点 Add 直出编辑框，无中间弹窗
- [x] 10.2 `VariableSchema` 增加可选 `file: { name, path }` 附件字段（path 复用 references/ 单段防逃逸契约），验证：schema 单测覆盖字段往返、路径逃逸拒绝、无附件旧数据兼容
- [x] 10.3 主进程原子保存 IPC：附件字节写入 references/ + 变量元数据同一次版本递增落盘；替换上传删除旧文件；删除按钮清附件（文件 + 元数据），验证：单测覆盖写入/替换/删除往返
- [x] 10.4 编辑对话框：类型为 excel/word/csv/md/file 时值栏改上传控件——无文件时点击上传；有文件时显示文件名、点击可覆盖上传、右侧删除按钮；保存后表格值列显示文件名；非文件类类型保持文本输入（secret 保持密码框），验证：手动走查各类型值栏形态与保存后表格显示
- [x] 10.5 回放注入：带附件的文件类对象在闸门解析值表时注入工件内绝对路径（upload 步骤直接可用），验证：单测覆盖路径解析注入
- [x] 10.6 回归：`npm test`、`npm run build`、`npx tsc --noEmit` 全绿；真机复验 Add 直开、文件类上传/覆盖/删除/值列文件名、回放上传步
