# Design

## Context

现状（见 proposal.md - Why 与 `docs/architecture.md` 的 Reference 一节）：Reference 是渲染层临时概念——`item.references` 由自动导出文件（.xls/.md，会话级）+ 上传文件（会话级，重启即丢）+ 从 `flow.variables` 水合的变量行拼成；`VariableSchema`（`engine/schema/src/schema.ts:122`）类型枚举 `string/text/email/date/number/secret/file`，名字受 ASCII 标识符正则约束；录制端以 `url_N`/`input_N`/`select_N`/`file_N`/`password` 命名并写成 `{{name}}` 模板；AI 提示词明确禁止改变量名；回放期任何缺失变量在模板渲染时硬失败（`engine/executor/src/template.ts`）。

已确认的关键决策（grill 结论）：label 显示名路线（机器键不动）；「正数」归校验；回放前统一校验 + 非必填空串；自研安全表达式子集；原始录制活动默认整段、Reference 随 Flow 版本落盘不跨版本迁移；文件持久化进工件目录 + .docx；AI 只管命名。

## Goals / Non-Goals

**Goals:**

- 单一共享实现：类型目录/显示映射、label 启发式、表达式引擎、校验求值器各只有一份，录制端、迁移、回放、渲染层全部复用。
- 旧 Flow 无损迁移到 schema v3，模板键与回放行为保持（除既定的「非必填空串」语义变化）。
- 渲染层零 Node 能力：新能力全部经既有 `window.flowlink` preload 分组暴露。

**Non-Goals:**

- 机器名/模板语法的 Unicode 放宽；AI 填必填/校验/活动；跨版本关联迁移；CSV 批量列头映射（见 proposal.md Out-of-Scope）。
- 表达式图灵完备（无循环/赋值/自定义函数定义）。

## Decisions

### D1：新增 `engine/reference` 纯函数包，依赖方向单向

新包只含纯函数与常量、不依赖其他 engine 包（对步骤证据用结构化平面对象入参，避免与 `engine/schema` 循环）：

- `type-catalog.ts`：封闭类型目录 + 显示映射（`url→地址`、`string→文本`、`integer→整数`、`decimal→小数`、`date→日期`、`secret→密钥`、`excel/word/csv/md→Excel/Word/CSV/Markdown`、`file→文件`）。
- `labels.ts`：label 启发式（证据优先级 label 文本 > placeholder > aria-label > name 属性 > 输入类型语义兜底；成对日期 -开始/-结束；同名去重序号；输出必定业务化措辞）。
- `expression.ts`：表达式子集的 tokenizer + Pratt parser + AST 求值器 + 静态校验（未知名、循环依赖、语法错误带位置）。
- `validate.ts`：校验求值器——输入对象集 + 用户值表，输出违规列表（对象 label + 规则 + 原因）与解析后值表（公式值、大小写转换、空串填充）。

依赖方向：`engine/schema`（Zod 枚举与迁移调用 catalog/labels）、`engine/recorder`（录制成 label）、`engine/executor`（闸门与值解析）、`src/main.ts`（IPC 暴露）→ `engine/reference`。备选方案「全部塞进 engine/schema」被否：求值器与启发式不是持久化契约，混入会让 schema 包承担运行时职责；备选「渲染层复制一份映射表」被否：违反单一实现且必然漂移。

### D2：Schema v3 扩展与迁移

`VariableSchema` 扩展：`label?: string`、`type` 枚举替换为新目录、`required?: boolean`（默认 false）、`validation?: { caseMode?: 'preserve'|'upper'|'lower'; format?: { preset?: 'email'|'url'|'phone'; pattern?: string }; sign?: 'positive'|'negative'|'nonNegative'|'nonPositive'; condition?: string; formula?: string }`、`activities?: string[]`（L1 分组 id）。新增 `flow.referenceFiles: Array<{ id, name, type, path }>`（path 相对工件根，契约校验防逃逸，复用既有相对工件引用校验模式）。`TEMPLATE_RE` 与 name 正则不动。

`migrateFlow` 增加 v2→v3：类型映射（`text`→`string`、`email`→`string`+email 预设、`number`→默认值含 `.` 判 `decimal` 否则 `integer`、其余保持），label 用 `labels.ts` 按步骤证据回填（纯函数、可在迁移内同步执行）。高于 v3 拒绝。回滚：`.bak` 机制既有；v3 文件不被旧版本接受（未来版本拒绝路径）。

### D3：校验闸门接在主进程回放启动处，executor 只消费解析后值表

回放启动 handler（主进程，已有 flow + 用户值）调用 `validate.ts`：有违规 → 结构化错误拒绝启动（渲染层列出全部违规）；无违规 → 把解析后值表（公式求值、大小写转换、空串填充完成）作为变量表传入 executor。executor 的模板解析不再承担缺失失败职责（防御性保留：仍拒绝对未知机器键的模板引用）。备选「闸门放渲染层」被否：校验必须与落盘契约同源，且渲染层无表达式引擎。

即时校验：渲染层编辑对话框经 preload IPC 调用同一 `validate.ts` 做单对象语法/静态检查（不落盘），保证编辑期与回放期判定一致。

### D4：AI refine 输出 `variableLabels`，机器键不可变

模型输出契约新增可选键 `variableLabels: [{ name, label }]`；后置守卫：`name` 必须在合并变量集中存在，否则整次生成拒绝（与既有「未知变量失败」同一严格度）；`mergeVariables` 以模型非空 label 覆盖启发式/旧值，其余元数据（必填/校验/活动）按源 Flow 保留。`config/prompts.json` 的 systemPrompt 与 generation 两模板：把「never rename a variable」改写为「机器键不可改、不得内联值，同时输出 variableLabels（语言随源、动词短语优先、成对区间加 -开始/-结束）」。备选「让模型直接改写步骤模板」被否：一处漏改即整次拒绝，重试成本高且违反 label 路线决策。

### D5：文件持久化与级联

新 IPC（`flow` 分组）：`flow:addReferenceFile`（字节经渲染层读入传入，主进程 `sanitizeSegment` 命名后写入 `artifacts/<recordingId>/references/`，追加 `flow.referenceFiles`，版本递增落盘）、`flow:removeReferenceFile`（删文件 + 元数据 + 版本递增）。accept 列表加 `.docx`；类型按扩展名映射目录。删除录制的级联清理已覆盖工件目录（desktop-shell 既有契约），无需额外改动。自动生成的 .xls/.md 导出保持会话级现状。

### D6：渲染层表格与数据流

`hydrateReferenceVariables` 携带全部新字段；`persistReferenceVariables` 经扩展后的 `flow:updateVariables` 全量回写；Object 列编辑只改 label（机器键不可编辑——顺带消除现状「UI 改名导致模板孤儿」的隐患）。列布局 7 列偏宽：表格横向滚动，校验列显示规则摘要、详情进对话框。显示映射/校验经 `window.flowlink.reference.*`（catalog、validate 单对象、validate 全量、文件 IPC）。

## Risks / Trade-offs

- [启发式 label 质量不稳定（证据缺失时命名平庸）] → 兜底命名保底业务化措辞；AI refine 是第二道提升路径；label 可人工编辑。
- [非必填空串是回放语义变化，旧 Flow 中「靠缺失失败暴露问题」的用例会静默通过] → 迁移不自动标记 required（尊重新语义）；回放报告中记录空串注入的对象清单，供事后排查。
- [表达式引擎范围蔓延] → 语言封闭为无赋值、无循环、白名单函数；语法非法即拒绝保存；不追求 Excel 兼容。
- [7 列表格在窄窗口拥挤] → 横向滚动 + 摘要列（校验/活动）详情进对话框，不在列内展开编辑。
- [AI label 输出质量/语言漂移] → 提示词锚定「语言随源材料」；label 仅显示层，错误不破坏回放；Confirm 界面可改。

## Migration Plan

1. 合入后旧 Flow 在下次加载时惰性迁移 v2→v3（既有 migrateFlow 路径），无批量预迁移步骤。
2. 回滚 = 恢复 `.bak` / 回退提交；v3-only 字段对旧代码为未知字段会被旧 Zod 剥离，不存在半解析状态。
3. 上传文件只在用户主动操作时进入工件目录，无存量迁移。

## Open Questions

- 显示映射文案的最终措辞（如 `url→地址` vs `url→网址`）可在实现期微调，不影响契约结构。
- 校验列摘要的呈现粒度（图标 vs 短语）属视觉细节，实现期定。

## 修订轮决策（2026-11-23 真机反馈）

### D7：业务友好编辑器——预设是 validation 结构的受限视图

`engine/reference` 新增 `presets.ts`（预设 ↔ validation 结构的编译/反编译）与 `describe.ts`（规则 → 中文业务短句，含「自定义规则」标记）。编辑对话框默认视图只呈现预设控件；自定义正则与原始条件/公式表达式移入默认折叠的高级区（`<details>`，保留即时校验 IPC 与保存阻断）；反编译失败的结构显示「自定义规则」。`describe.ts` 同时供表格校验列与回放闸门违规文案使用，保证三处措辞一致。备选「为业务用户另设一套简化 schema」被否：两套结构必然漂移，预设只是同一结构的友好投影。

日期自动计算预设集：手动填写 / 今天 / 今天 + N 天 / 今天 − N 天（N 为数字输入）→ 编译为 `DATEADD(TODAY(), N, "day")`；句子式条件必填「当『X』已填写时」→ 编译为 `NOT(ISEMPTY(X))` 形式的条件（X 按 label 解析为对象引用）。条件/公式预设不追求覆盖全部表达式——覆盖不了的高级区始终可用。

### D8：Refine 活动默认关联——证据推导为主，AI 建议补空

新材料落盘（`recording:persistMerged` 路径，auto-sanitize 孪生同路）前执行 `deriveActivities(flow)`：遍历步骤值携带字段收集 `{{name}}`（复用 `parseTemplate`），映射到其所属顶层分组 id 集合。合并顺序：先清除自源继承的过期分组 id（新材料分组结构不同，旧 id 悬空），再写使用证据推导结果，最后用模型 `variableActivities` 建议填充无使用证据的变量（未知机器键整次拒绝、与 variableLabels 同一报错面；未知分组 id 剔除不拒）。修订 D4 的「AI 只管命名」为「AI 管命名 + 活动关联建议（证据优先）」。备选「纯 AI 推断」被否：使用证据是免费的精确事实，AI 只在证据缺位时补位，幻觉面最小。

### D9：对话框布局

`.reference-dialog` 由固定 480px 改为约 720px（`max-width: calc(100vw - 48px)`、`max-height: 90vh`、内容滚动），表单按「基本（两列网格）/ 填写规则 / 活动关联 / 高级（折叠）」分区；表格列头保持现状（Object 为用户定名，不做本轮 i18n）。

### D10：文件类对象的值附件与 Add 直开（修订轮 3）

`VariableSchema` 增加可选 `file: { name, path }`（path 复用 `flow.referenceFiles` 的 references/ 单段防逃逸契约）。主进程提供原子保存：附件字节写入 references/ 与变量元数据在同一次版本递增中落盘（替换上传时删除旧文件；删除按钮清附件与文件），避免文件与元数据脱节。编辑对话框中文件类类型（excel/word/csv/md/file）的值栏改为上传控件（文件名展示、点击覆盖、右侧删除）；回放闸门解析值表时，带附件的文件类对象注入工件内绝对路径。Add 按钮直接打开对象编辑框，原「Add variable / Upload files」中间选择弹窗删除——独立文件上传入口收敛为「新建文件类对象 + 上传控件」，与用户「值即文件」的心智一致。备选「附件也登记进 flow.referenceFiles 以复用下载」被否：同一文件两处登记会漂移，对象行自身即唯一入口。
