# Design

## Context

见 proposal.md。关键事实约束：

- rrweb 数据与 Replayer 本身已被隔离 harness 验证正常（2026-11-18 16:10 录制，跨 3 次导航 759 事件，标准 Replayer + 正确加载的 `rrweb/dist/style.css` 可渲染博世首页与微软登录页）；应用内仍黑屏，问题收窄到**应用内播放器**（样式加载链路、舞台容器布局、量测时机三处之一或组合）。
- 元素裁剪已用 CDP screencast 单帧采集且无闪烁投诉——整页步骤截图复用同一机制。
- condition 缺省=顺序继续是语义变更：存量 flow 已扫描（0 个 condition），无迁移。
- AI 面板快捷区现有结构：`assistantQuickActions` 内三个互斥块（options/refine/group），由 `renderSummaryWorkspace` 的 `showOptions`/`refineOptions`/`selectedGroup` 显隐（`renderer/app.js` ~5154-5296）。

## Goals / Non-Goals

Goals：应用内回放可见；步骤截图回归且不引回闪烁；AI 面板状态机与用户操作习惯一致；AI 分组按业务阶段表达。
Non-Goals：连线着色、Instruction 重构、stepId 级跳转、按步定位 rrweb 回放（条件路线）、任何自动 AI 分析。

## Decisions

1. **黑屏修复以「应用内可观测」为准**：在 `mountRrwebPlayer` 增加布局自检（量测等待 iframe rect 非零的轮询已有；补充：vendor.css 规则命中检测——`getComputedStyle(.replayer-mouse-tail).position === 'absolute'`，未命中时以显式错误提示并在播放器根节点注入兜底内联样式）。兜底内联样式注入（`position:absolute` 三件套）作为第二道防线，即使 CSS 链接失效也保证布局成立。不在无法复现的前提下盲改 Electron 加载链路。
2. **整页步骤截图 = screencast 整帧落盘**：`screenshotRegion` 已有「screencast 单帧 + 失败回退 page.screenshot」骨架；整页场景直接复用（无裁剪区，整帧写 `record/screenshots/step-NNNN.png`，跳过 sidecar）。采集点在动作步骤完成处（record.ts 现有整页截图调用位恢复），经同一 busy 串行化避免与元素裁剪竞争。
3. **AI 面板状态机**：`showOptions` 的触发从「进入分析页」改为「用户点击 Refine 按钮」（状态位 `refineMenuOpen`，切页/切换工作流重置）；options 块选择 optimize → 置 `refineOptions`（现表单显隐条件不变）；「Analyze last failure」「AI Continue」为快捷区预设项（仅 Test 存在失败结果且无运行中回放时可用），AI Continue 复用 `runAiAssistedTest`，删除 `#aiContinueTest` 独立按钮；自动发消息路径（Test 失败 → `startFlowLinkAIAdvice(replayFailure)`）删除，改由预设项按需触发同一 advice 请求。
4. **chips 表单**：勾选态与文本态分离（文本 `input` 事件不再触发快捷区重渲染——当前 bug 根因是 `renderSummaryWorkspace` 在输入时重建了勾选 DOM）；勾选项渲染为 chips（点击 × 移除=取消勾选）；提交组装多行 instruction（每勾选项一行 `- <preset>` + 空行 + 文本），聊天消息按 chips + 文本段渲染（消息结构带 `presets` 数组，渲染层识别）。
5. **condition 语义（stepId 级目标）**：schema 分支字段语义由组 ID 改为**步骤 ID**（沿用现有字段名或改为 `trueStepId/falseStepId`，实现时定名并全链路一致；步骤 id 全局唯一、与组 id 共享命名空间——rehydrate 的 uniqueId 已保证）。契约：删除「必须是组末/直接位于顶层组」校验；目标必须解析到同 Flow 内已存在步骤（校验 stepId→扁平下标可解析）。run.ts：`groupStartIndices` 旁建 `stepIndexById` 映射；分支目标存在 → `branchCursor = stepIndexById.get(target)`（不再限于组开头）；缺省 → 顺序继续（不清 branchCursor、不终止）；防环沿用按顶层组访问计数（跳进组内任意步骤同样使该组计数+1）。`flow-graph.js`：决策节点提取从「仅组末」放宽到组内全部 condition；分支边连到任意目标节点（组卡或组内步骤——组内步骤目标画到组卡内对应行或组卡锚点，实现取可读性优先的简化）；缺省分支画顺序继续边。提示词同步描述新契约。存量 flow 用户自行删除，不做迁移（字段语义 breaking 已在 proposal 标注）。
6. **Refine 失败调查（根因已实锤）**：报错 `Cannot read properties of undefined (reading 'kind')` 已在本机构造载荷复现——模型输出的 assert/condition 步骤缺 `assertion` 字段时，`rehydrateSteps` 不校验直接放行，`collectTemplateRefs` 的 `visitAssertion(assertion)` 在 parseFlow 契约校验**之前**读到 `undefined.kind` 崩溃（src/ai-refine.ts，第一轮即存在的潜伏 bug；与代理/网络无关，已排除）。修复：① `visitAssertion` 加空值守卫（缺失不再崩溃）；② 容忍策略——assert/condition 缺 `assertion` 的模型生成步骤**丢弃并追加 risk**（「模型输出的校验步骤 X 缺少断言定义，已移除」），让 Refine 能成功产出而非整次失败（assert 是模型增强步骤、非录制证据，丢弃不违证据纪律）；③ 错误透出（决策 8）兜底其余失败形态。复现脚本保留在 `scratch-refine-repro/crashtest.mjs`（esbuild 打包后运行），修复后应输出「已移除」路径。
7. **提示词**：`config/prompts.json` 的 `generation.autoSanitize`/`generation.refine`/`systemPrompt` 中「dedicated Sign in group / gate group + sign-in group」结构描述改为「登录并入首个业务阶段组：入口导航 → 可选网关条件（已进入则跳后续业务目标，缺省分支顺序继续）→ isOptional 凭据/账号步骤 → 目标页断言收尾」；同步 systemPrompt 中 condition 契约描述（组内任意位置、缺省=顺序继续、目标为任意已存在步骤）。
8. **错误透出**：`pi:generateFlow`/`pi:repairFlow` 失败时错误对象带 `detail`（阶段 + 底层原因），AI 面板消息渲染完整文本。

## Risks / Trade-offs

- [应用内黑屏根因未最终定位（harness 无法复现应用内 DOM）] → 修复含三道防线（CSS 命中检测/兜底内联样式/显式报错），真机验证清单必测；若仍黑，下一步在 `--dev` 下 dump 应用内 computed styles。
- [screencast 整页截图仍可能在个别驱动上闪] → `FLOWLINK_DISABLE_RECORDER_SHOTS` 开关 + 真机验证项；仍闪则启用按步定位 rrweb 路线（out-of-scope 备选）。
- [缺省分支与 stepId 级目标是 breaking（旧语义=组级/终止）] → 用户确认自行删除存量 flow，无迁移；提示词与契约同步描述，spec 已列迁移说明（删除存量即可）。
- [chips 交互改动波及 refine 表单重建逻辑] → 表单 DOM 只在进入 refine 模式时重建一次，输入期间不重建（bug 根因修复即此）。

## Migration Plan

用户删除既有 flow（自行操作），无数据迁移。回滚 = revert 提交；行为回退点：condition 分支语义（如需临时回退，恢复 run.ts 的组级映射分支）。

## Open Questions

- 「Analyze last failure」的 advice 请求是否复用现有 `advice.defaults.replayFailure` 文案（倾向复用，`failureContext` 附失败步骤详情）——实现时定。
