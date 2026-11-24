# Tasks

## 1. schema v4 契约与迁移

- [x] 1.1 `VariableSchema`：删 `validation`、增 `rules`/`locator`（`required`/`label`/`type`/`activities`/`file` 不变），`SCHEMA_VERSION=4`，读取时剥离旧 `validation`，验证：schema 单测覆盖新字段往返与旧字段剥离
- [x] 1.2 `describe.ts` 收缩为迁移转换器（结构化规则 → 中文句子，多条「；」连接），`migrateFlow` 增 v3→v4（规则转文本 + locator 按「页面 · 控件」证据回填），验证：迁移单测覆盖各规则组合转换、v1–v3 升 v4 步骤与模板键逐字节不变
- [x] 1.3 永久回归：flow-schema 相关 node:test 更新/新增并通过（`npm test`）

## 2. 引擎与闸门收缩

- [x] 2.1 删除 `engine/reference` 的 `expression.ts`/`presets.ts` 及其测试；`validate.ts` 收缩为必填缺失收集 + 非必填空串 + 附件绝对路径解析，验证：收缩后单测覆盖必填拦截清单、空串注入、附件路径注入
- [x] 2.2 主进程闸门与 `validateObject` IPC 收缩（即时表达式校验入口删除，label 去重保留）；executor 值表解析删除公式求值与大小写转换，验证：闸门集成测试更新后全绿
- [x] 2.3 清理死引用（preload/渲染层对已删 IPC 与 describe 摘要的调用面），`npx tsc --noEmit` 零错误

## 3. 录制端 locator

- [x] 3.1 `record.ts` 在 label 产出的同点产出 locator（「页面 · 控件」，url 变量取「地址栏 · 系统名」，证据缺失留空），验证：录制单测断言新变量同时携带 label 与 locator、模板值仍为机器键

## 4. AI variableRules

- [x] 4.1 `mergeVariables` 扩展 variableRules（未知机器键整次拒绝、非空覆盖、Mandatory/locator 不来自模型），验证：node:test 覆盖建议覆盖/未知键拒绝/其余元数据按源保留
- [x] 4.2 `config/prompts.json` systemPrompt 与 autoSanitize/refine 追加规则建议指引（自然语言、语言随源、证据不足留空），验证：prompts 占位符校验单测通过
- [x] 4.3 生成后置守卫扩展 variableRules 拒绝路径（与 variableLabels 同一报错面），验证：node:test 覆盖拒绝路径

## 5. 渲染层

- [x] 5.1 表格列序调整（勾选 | Object | Type | Locator | Mandatory | Validation | Activities | Value | 操作），Validation 列显示规则文本（截断 + 悬停全文，列名保持 Validation），列头 Required→Mandatory，表格横向滚动并加大各列宽度，验证：手动检查列序、列名、列宽与滚动观感
- [x] 5.2 编辑对话框重构：分区「基本（label/类型/Locator/值/Mandatory）/ 规则（单个多行文本框，自然语言占位示例）/ 活动关联」，删除预设控件、高级折叠、表达式错误框与相关接线；文件类值上传控件与密钥掩码保持，验证：手动走查对话框结构、旧迁移对象规则文本还原
- [x] 5.3 `hydrateReferenceVariables`/`persistReferenceVariables` 往返 `rules`/`locator`；闸门拒绝 UI 改为必填缺失清单，验证：编辑保存重开字段保持、必填缺失启动回放见清单
- [x] 5.4 移除占位文件生成（`ensureReferenceFiles` 的 .xls/.md 分支），Download 打包保留仅含附件，验证：新录制 Reference 页无自动 .xls/.md 行、附件仍可打包下载
- [x] 5.5 活动列交互：每个已选活动独立成行徽片（行间间隔），点击跳转 Process 页并触发对应 L1 分组既有选中高亮（跨页签传递分组 id），未 Refine 录制整段活动不可点击，验证：手动点击活动徽片见跳转与高亮、原始录制点击无跳转

## 6. 文档与验证收尾

- [x] 6.1 更新 `docs/architecture.md` Reference 一节（rules 自由文本、Mandatory 闸门、locator、占位文件移除、variableRules 契约），验证：文档与实现行为一致
- [x] 6.2 运行 `npm test`：全部套件通过
- [x] 6.3 运行 `npm run build` 与 `npx tsc --noEmit`，两者零错误
- [x] 6.4 真机验证：新列序（含 Validation 列）与 Locator/Mandatory/规则文本框、列宽与横向滚动观感；活动徽片点击跳转 Process 高亮；v3 旧录制打开后规则转文本正确；refine 后 variableRules 建议可改；必填缺失拦截与非必填空串不变；无占位文件行（用户 2026-11-24 确认通过）
