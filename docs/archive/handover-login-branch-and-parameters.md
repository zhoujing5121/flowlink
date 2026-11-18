# 交接文档：录制后 AI 细化的登录分支结构与用户操作参数化

> 交接性质：本文档是**已与用户确认的实施方案**，请按此实现，不要重新设计。
> 若实现中发现文档与代码现状冲突（行号可能因后续提交偏移），以代码为准并在完成后说明偏差。
> 撰写日期：2026-11-13。基线 commit：`2f24788`（master）。

---

## 0. 任务一句话

重写录制后 AI 自动细化（auto-refine）的提示词并补齐配套代码，使 REFINED 流程能够：
1. **SSO 登录**三态自适应（未登录全量登录 / session 过期只点账号 / 已登录零操作直达）；
2. **账号密码登录**两态自适应（未登录或过期则登录 / 已登录跳过）；
3. **用户操作参数化**：携带值的动作（input / select / upload / 对话框文本）全部固化为 Reference 页变量，回放时可指定参数值。

### 非目标（刻意不做，见第 7 节）

- 元素级参数化（"回放时选哪个账号"这类点击目标的选择）；
- 给 condition 评估加等待窗口、让 assert 读取 `step.timeout`；
- 多密码字段支持（现在所有密码共用 `{{password}}`）；
- 重新生成已有的 REFINED 流程；
- 修改 advice / takeover 提示词。

---

## 1. 目标行为（验收基准）

SSO 场景（录制时必须未登录）：

| 回放时状态 | 网关判断 | 行为 |
|---|---|---|
| 未登录 | 目标页标志元素不可见 → 进登录组 | 输入用户名密码 → 提交 → 点账号 → 进目标页 |
| 已登录、session 过期 | 不可见 → 进登录组 | 用户名/密码字段缺失被跳过 → 只点账号 → 进目标页 |
| 已登录且未过期 | 可见 → 直达业务组 | 不做任何登录操作 |

账密场景：

| 回放时状态 | 行为 |
|---|---|
| 未登录或 session 过期 | 自动重定向到登录页 → 填账号密码 → 点登录 → 进目标页 |
| 已登录 | 不进行任何操作 |

参数化：Reference 页出现本次录制全部值参数（`input_N` / `select_N` / `password` / `file_N`），回放前可修改取值并生效。

---

## 2. 已核实的代码现状（调研结论，可直接引用）

### 2.1 AI 细化管线

- 提示词唯一来源：`config/prompts.json`，由 `src/prompts.ts` 的 `loadPromptTemplates()` 加载校验（每个 key 都是 `requireString`，**本次不新增 key，只改既有 key 的内容**，无需改 prompts.ts）。
- 生成管线：`src/ai-refine.ts` 的 `generateRefinedFlow()`。流程 = `projectFlows()`（投影：元素替换为 `{"$ref":"eN"}` 并建元素库）→ 组装提示词 → Pi 调用 → `extractJsonObject()` → `rehydrateSteps()`（元素字段只接受 `$ref`，其余字段原样透传）→ `mergeVariables()` → `parseFlow()` 完整校验。
- 触发点：`src/main.ts` `autoRefineRecording()`（约 line 691），录制 Stop 后 fire-and-forget（约 line 801），成功经 `persistMergedFlow()` 另存 REFINED 孪生（`isMerged: true`，不会再二次细化）。`config/pi-settings.json` 的 `autoRefine: false` 可关闭。
- **投影字段缺口（本次要修）**：`src/ai-refine.ts` line 119 `BASE_FIELDS = ['label', 'timeout', 'page']` —— `isOptional`、`pageUrl`、`systemName` **都不投影**，模型看不到录制器打的认证跳转标记，也看不到元素所在页面。
- **变量继承现状**：`mergeVariables()`（line 388）会把源流程 `flow.variables` 全部并入输出（secret 除外不接受模型新增）；系统提示词禁止模型输出 `flow.variables`。所以录制期参数**已经**能进入 REFINED 流程，缺的是防回退保护（见 4.3）。

### 2.2 执行器

- `isOptional` 目前**只对 navigate 生效**：`engine/executor/src/run.ts` line 599-615，navigate + isOptional + previousUrl → 等 `OPTIONAL_NAV_WAIT_MS`（800ms，actions.ts line 103）后按 `sameSitePath` 判断是否已自行重定向，是则 skip。其他步骤类型上的 `isOptional` 标志被**忽略**——这是 SSO 过期场景的核心缺口。
- `condition` 步骤：run.ts line 757-778，`evaluateAssertion()` 以 **waitMs=0 即时快照**判定（verify.ts line 294-308），按 `trueGroupId/falseGroupId` 跳到目标 group 的展开起点（`branchCursor = groupStartIndices.get(...)`）；缺省目的地 = 结束整个运行；每个顶层 group 每次运行最多进 3 次（`FLOW_LOOP_LIMIT`）。group 执行完**自然落到下一个顶层兄弟项**。
- `assert` 步骤：`runAssertion()` 默认 5s 轮询（`EXPECT_WAIT_MS`，verify.ts line 28），**不读取** `step.timeout`。
- 模板渲染：`engine/executor/src/template.ts` `renderStep()` 已覆盖 input.value、**select.value（单值与数组逐项）**、navigate.url、upload.files、dialog.promptText、wait.prompt、key.key、expect(urlChange.pattern / textChange.to)、assert/condition 的 text/value。**select 传 `{{var}}` 执行器已支持，无需改执行器**。
- 元素解析：`resolveTarget()`（run.ts line 435）支持 `{ requireVisible, allowAi, elementWaitMs }` 选项；元素找不到抛 `ElementNotFoundError`（`engine/resolver/src/index.js` 导出），分类为 `ELEMENT_NOT_FOUND`。

### 2.3 录制器

- 参数化位置：`engine/recorder/src/record.ts` `buildStep()`（line 879 起）：
  - input：密码/掩码 → `{{password}}`（secret 变量，line 917-924）；普通文本 → `{{input_N}}`（defaultValue=录制值，line 926-934）；
  - upload → `{{file_N}}`（line 872-877）；
  - **select（line 936-949）：值直接内联，未参数化——本次要修**；
  - 会话级计数器 `inputSeq` / `uploadSeq` 与 `variables` Map（line 236 附近声明）。
- 认证跳转：`engine/recorder/src/classify.ts` 的 `AUTO_NAVIGATION_TYPES = {sso_redirect, login_redirect, auto_redirect}`；`synthesizeOptionalNavigations()`（plan.ts）合成带 `isOptional` 的 navigate 步骤。默认 IdP host/path 正则在 classify.ts line 13/16。
- 步骤携带 `pageUrl` / `systemId` / `systemName` / `tabId` 溯源字段（record.ts line 258-262 富化）。

### 2.4 schema（`engine/schema/src/schema.ts`）

- `isOptional` 是 BaseStep 通用字段（line 152），注释写"目前仅录制器对机器发起的认证跳转 navigate 步骤设置"——本次只改注释，**无结构变化、不升 schemaVersion、无迁移**。
- condition 契约（validateFlowContract，line 529 起）：必须直接位于顶层 group 且是该 group 最后一步；必须有 target；只能跳到**已存在的非空** group。
- 密码输入必须 `{{}}` 模板（line 503-521 契约强校验）；`parseFlow()` 会跑契约校验（io.ts line 31），AI 输出同样受限。

### 2.5 Reference 页 / 回放传值（无需改动，仅供理解）

- `renderer/app.js` line 3988：Reference 项从 `flow.variables` 单向水合；line 4025 `referenceVariablesForReplay()` 回放前收集 name→value（含 secret，只留渲染进程内存）传入 `playback.run({variables})`；line 4038 `persistReferenceVariables()` 经 `flow.updateVariables` 回写非 secret 默认值。

### 2.6 现有提示词的问题

`generation.autoSanitize` 现在指示 *"keep at most the explicit entry navigation and drop intermediate identity-provider hops"*——与登录分支保留的需求**方向相反**，且完全不提 `isOptional`、condition 结构和参数保护。

---

## 3. 设计：为什么是「网关 condition + 容忍式登录组」而不是平行分支

字面的"三条平行分支组"与现有 condition 模型冲突：

1. condition 只能是所在 group 的最后一步，且只能跳到**已存在的非空** group——"已登录直通"分支必须是空组，不合法；
2. 分支组执行完会自然落到下一个兄弟组，平行分支会互相"掉进去"，每支末尾都得补路由 condition；condition 缺省目的地是**结束整个运行**，登录失败会被吞成静默成功；
3. 每 group 每次运行最多 3 次访问，链式跳转易触顶。

因此统一为下列 IR 结构（SSO 与账密同一模式；SSO 多出的"点账号"步骤天然由可选性覆盖）：

```
组1「打开系统」
  navigate 入口URL（若录制里有；回放器对非 navigate 开头的流程会自动打开 startUrl）
  [保留录制器标记 isOptional 的认证跳转 navigate 步骤，位置不变]
  condition: 目标页标志元素 visible？      // 即时快照判断
    → true : 组3（业务操作）              // 已登录且未过期 → 什么都不做
    → false: 组2（登录）
组2「登录」（逐步容忍）
  input  用户名  {{input_N}}   isOptional  // 元素不出现 → 短等待后跳过
  input  密码    {{password}}  isOptional
  click  登录/下一步              isOptional
  click  选择账号                  isOptional  // 仅 SSO 选账号场景出现
  assert 目标页标志元素 visible              // 登录没走通 → 运行失败，绝不静默
组3「业务操作」
  ...（原业务步骤，值参数原样保留）
```

要点：

- 组2 执行完自然落到组3，false 路径无需回头路由；网关误判（已登录但重定向慢，快照时标志元素还没出现）会误入组2，由可选步骤自动跳过、末尾 assert 收敛——**结构自愈**。
- "目标页标志元素"由 AI 从元素库选，优先取**第一个业务步骤的 target**（它天然只在登录成功后的页面上存在）。这也是投影必须补 `pageUrl` / 元素库摘要必须带页面 URL 的原因（4.2）。
- 录制的 navigate 步骤不带 expect（record.ts buildStep 不设置），提示词同时要求 AI 不给入口 navigate 加 expect——避免未登录时入口步骤因 urlChange 期望直接失败。

---

## 4. 改动明细

> 建议实现顺序：4.2 → 4.4（执行器，可独立验证）→ 4.5（录制器）→ 4.3（守卫）→ 4.1（提示词）→ 4.6 → 4.7。
> 其中 4.1 依赖 4.2 的投影字段；4.3 与 4.1 相互独立。

### 4.1 `config/prompts.json`（纯配置，无代码）

三个既有 key 的修改。注意 JSON 字符串须单行、换行用 `\n` 转义；下面给出可读文本。改完确认仍能被 `loadPromptTemplates` 加载（跑一次 `npm run build` 即会走到）。

**(a) `systemPrompt`：在 `## Advice focus` 一节之前插入以下两节**（其余原文不动）：

```
## Optional steps and authentication structure

- A step with "isOptional": true may be skipped at replay without failing: optional
  navigate steps are skipped when the browser has already redirected by itself;
  optional element steps (input, select, click, hover, upload) are skipped when
  their element does not appear within a short wait. Use isOptional only for steps
  that legitimately may not apply, such as credential fields that are absent when
  an SSO session is remembered.
- When restructuring a recording that contains a login or SSO segment, keep it as
  a dedicated "Sign in" group with tolerant (isOptional) credential steps,
  preceded by a gate group whose final condition checks a target-page element and
  routes to the business group when already logged in. Close the sign-in group
  with an assert on that same target-page element. Never invent credentials,
  URLs, or login steps the recording does not contain.

## Parameter preservation

- Recorded input values, select values, upload files, and dialog texts use
  {{name}} variable templates filled from the Reference page at replay. Preserve
  these templates exactly as given: never replace a template with its recorded
  value, never rename a variable, never drop an input, select, or upload step.
  Password inputs must keep {{password}}.
- Do not output flow.variables; variable definitions are merged from the source
  flows automatically.
```

**(b) `generation.autoSanitize`：整键替换为**（保留原有通用清洗/分组/标签规则，新增认证重构与参数保护）：

```
Task: sanitize and structure a freshly recorded FlowLink workflow for a business user.

You receive one executable Flow as compact steps plus an element library. Produce ONE
refined workflow that replays the same business intent with higher reliability and
reads like a clear business procedure.

Cleanup:
1. Remove noise: accidental clicks with no effect, duplicate navigations, redundant
   waits, leftover exploration steps.
2. Keep chronological order and page/tab assignments; do not reorder across
   cause/effect boundaries.
3. Preserve every input, select, and upload step and keep its value/files template
   exactly as recorded ({{input_1}}, {{select_1}}, {{password}}, {{file_1}}, ...).
   Never inline recorded values and never rename variables.
4. Keep steps marked "isOptional": true (usually authentication redirects); do not
   merge or drop them.
5. Reference elements only via {"$ref": "eN"} from the element library.

Authentication restructuring (only when the recording contains a login or SSO
segment):
The recording starts logged out. Its authentication segment typically contains: an
entry navigation, recorder-marked optional auth redirects (navigationType
sso_redirect / login_redirect / auto_redirect), a username input, a password input,
a submit or "next" click, sometimes an account-picker click, and then the first
business actions on the target page. Restructure exactly this segment into:

- Group "Open <system>": the entry navigation to the target system (keep it if
  recorded; the runtime also opens the recorded start URL on its own). Do not
  attach any expect to it. End the group with a condition step: target = an
  element that exists only on the target page after login (prefer the target of
  the first business action), assertion {"kind": "visible"}, trueGroupId = the
  business group, falseGroupId = the sign-in group. When already logged in, the
  run jumps straight to the business group and performs no login action.
- Group "Sign in": the credential steps in recorded order (username input,
  password input, submit/next click, account-picker click if present), each with
  "isOptional": true. At replay, steps whose element is absent are skipped — this
  automatically covers the SSO "session remembered, only pick the account" case.
  Close the group with an assert step: target = the same target-page element,
  assertion {"kind": "visible"} — a failed login must fail the run instead of
  silently continuing.

If the recording has no authentication segment, keep the entry navigation as-is
and never invent login steps.

Business grouping:
- Group the remaining steps into a small number (typically 2-6) of labeled
  top-level groups, one per business stage of the task. Name each group after the
  business stage, not after pages or technology (for example "Sign in", "Fill in
  order details", "Review and submit" — adapt to the actual task).
- Use the source page URLs, step labels, and element names as evidence for
  naming. Do not leave a long flat step list: whenever more than a few
  consecutive steps belong to one stage, wrap them in a group.

User-friendly step descriptions:
- Give every step a short, plain-language "label" that says what the user does or
  sees on the page (for example "Click the Submit order button", "Enter the
  customer name", "Wait for the order confirmation page").
- Never expose selectors, CSS/XPath, element ids, coordinates, or technical
  jargon in labels or group labels.
- Write the title, summary, labels, rationale, and risks in the same language as
  the source labels.

Return JSON only: {"title": string, "summary": string, "steps": [...],
"rationale": string[], "risks": string[]}. Title must start with "REFINED".

Source Flow metadata: {{metadata}}
Element library:
{{library}}
Source steps: {{steps}}
```

**(c) `generation.refine`：在 "Grounding rules:" 列表末尾追加两条**（其余不动）：

```
- Preserve variable templates exactly ({{input_1}}, {{select_1}}, {{password}}, ...);
  never inline values, rename variables, or drop input/select/upload steps.
- Preserve "isOptional" flags. If the instruction touches the login segment, keep
  the gate-condition + tolerant sign-in group structure: never turn a tolerant
  login into steps that fail when the session is already valid.
```

### 4.2 `src/ai-refine.ts` — 投影补字段（提示词生效的前提）

1. **`BASE_FIELDS`（line 119）**：`['label', 'timeout', 'page']` → `['label', 'timeout', 'page', 'isOptional', 'pageUrl', 'systemName']`。
   - `rehydrateSteps` 的 `walk()` 对除 target/from/to/expect/id 外的字段原样透传，模型保留这些字段即可存活；输出体积增幅（pageUrl ~50 字符/步）相对 STEPS_BUDGET 60k 可忽略。
2. **元素库摘要带上页面 URL**：`LibraryBuilder.add(ref, origin)` 增加可选第三参 `pageUrl?: string`，存入 entry；`elementSummary()` 在摘要末尾追加 `· page <截断的 URL>`（复用 `truncateText(url, 80)`）。调用侧（`projectStep` 里三处 `lib.add(...)` 及 `projectExpect`）把所在步骤的 `step.pageUrl` 传入。去重键不变（同元素多步骤共享首见 entry 即可）。
   - 目的：模型据此区分"登录页元素 / 目标页元素"，才能选出网关 condition 的标志元素。

### 4.3 `src/ai-refine.ts` — 生成后置守卫（参数保护的代码保证，不依赖模型自觉）

在 `generateRefinedFlow()` 中，`const variables = mergeVariables(flows, parsed.variables)`（line 524 附近）之后、`parseFlow(...)` 之前插入：

```ts
// 收集输出步骤引用/定义的全部模板变量名
const { used, defined } = collectTemplateRefs(steps)
// 1) 引用了不存在的变量 → 整次生成失败（源流程不动，与现有错误路径一致）
for (const name of used) {
  if (!defined.has(name) && !variables.some((v) => v.name === name)) {
    throw new Error(`生成的步骤引用了不存在的变量 {{${name}}}；源流程未改动`)
  }
}
// 2) 剪除输出中不再被引用的变量（防 Reference 页出现死参数）
const usedOrDefined = new Set([...used, ...defined])
const prunedVariables = variables.filter((v) => usedOrDefined.has(v.name))
// 3) 源流程有 secret 变量而输出不再使用 → 追加一条 risk（提示凭据步骤可能被删）
const secretDropped = flows.some((f) => (f.variables ?? []).some((v) => v.secret))
  && !prunedVariables.some((v) => v.secret)
// …若 secretDropped，向返回的 risks 数组 push 一条说明
```

`collectTemplateRefs(steps: Step[]): { used: Set<string>; defined: Set<string> }` 新增为模块内纯函数（可导出供测试）：

- `defined`：递归收集 `extract` 步骤的 `into`（**运行时变量，必须排除在校验外**，否则误报）；
- `used`：对下列字符串字段调用 schema 已导出的 `parseTemplate()`（模板语法非法会让其抛错——直接让生成失败，符合"绝不静默"的仓库风格）：
  - `input.value`；`select.value`（string 或 string[] 逐项）；`upload.files[]`；
  - `dialog.promptText`；`navigate.url`；`wait.prompt`；`key.key`；
  - `expect.urlChange.pattern`；`expect.textChange.to`；
  - `assert` / `condition` 的 `assertion.kind === 'text'` 时的 `equals`/`contains`、`kind === 'value'` 时的 `equals`；
  - 递归进入 `group.steps`。
- 最终 `variables` 使用 `prunedVariables` 传入 `parseFlow`。

### 4.4 `engine/executor/src/run.ts` + `actions.ts` — 通用 isOptional 跳过（SSO 过期场景的核心）

1. `actions.ts`：在 `OPTIONAL_NAV_WAIT_MS`（line 103）旁新增并导出 `OPTIONAL_ELEMENT_WAIT_MS = 2_000`。
2. `run.ts` 主循环内、现有 navigate-isOptional 块（line 599-615）之后插入：

```ts
// 可选元素步骤：目标在短窗口内不出现 → 跳过（不算失败）。
// 与 navigate 的可选分支同语义；用于登录组容忍（如 SSO 记住会话时凭据字段缺失）。
if (
  item.step.kind !== 'navigate' &&
  (item.step as { isOptional?: boolean }).isOptional === true &&
  'target' in item.step && item.step.target
) {
  const optionalStart = Date.now()
  try {
    await resolveTarget(item.step.target, {
      requireVisible: true,
      allowAi: false,
      elementWaitMs: OPTIONAL_ELEMENT_WAIT_MS,
    })
  } catch (err) {
    if (err instanceof ElementNotFoundError) {
      pushLog(`可选步骤：${item.stepId} 的目标元素未出现，跳过`)
      const stepResult: StepResult = {
        stepId: item.stepId,
        kind: item.step.kind,
        status: 'skip',
        ms: Date.now() - optionalStart,
      }
      steps.push(stepResult)
      opts.onStep?.(stepResult)
      continue
    }
    // 非 ElementNotFoundError 不吞：走正常执行路径按原语义失败
  }
}
```

实现要点：

- `ElementNotFoundError` 从 `'../../resolver/src/index.js'` 导入；
- 探测成功的步骤继续走正常执行（会二次 resolve，元素已在页面、L1 命中成本低，**可接受，不要为此重构 withTarget**）；
- skip 的 StepResult 写法**镜像** navigate 可选分支（只 push steps + onStep，不 push details）；
- 不对 `NOT_ACTIONABLE`（如 HIDDEN）做跳过——保守起见只按"找不到元素"跳过，避免掩盖真实错误；
- TypeScript 上 `item.step` 是联合类型，需要窄化（如上用 `'target' in item.step`）。

### 4.5 `engine/recorder/src/record.ts` — select 参数化

`buildStep()` 的 `case 'select'`（line 936-949）改为：

```ts
case 'select': {
  if (!target) return undefined
  const values = action.selectedValues?.length
    ? action.selectedValues
    : action.value !== undefined
      ? [action.value]
      : []
  if (values.length === 1) {
    const name = `select_${++selectSeq}`
    variables.set(name, {
      name,
      type: 'string',
      defaultValue: values[0] ?? '',
      secret: false,
      source: 'input',
    })
    return { kind: 'select', id, target, value: `{{${name}}}` }
  }
  // 多选语义模糊，保持内联（renderStep 对数组逐项渲染模板，将来要参数化也兼容）
  return { kind: 'select', id, target, value: values }
}
```

- 在 `inputSeq` / `uploadSeq` 声明处（`variables` Map 附近，line 236 一带）同样增加 `let selectSeq = 0`。
- 执行器无需改动（`renderStep` 已渲染 select 模板，actions.ts 的 selectOption 有按 label 兜底）。

### 4.6 `engine/schema/src/schema.ts` — 仅注释

`BaseStepSchema.isOptional`（line 149-152）的注释由"目前仅录制器对机器发起的认证跳转 navigate 步骤设置"改为反映新语义：navigate 由录制器对认证跳转设置；元素步骤（input/select/click/hover/upload/wait-element）可由 AI 细化或手动设置，回放时目标元素在短窗口内未出现则跳过。**不改结构、不升 schemaVersion、无迁移。**

### 4.7 文档（按 AGENTS.md 要求）

- `docs/architecture.md`：录制管线第 10 条补 select 参数化；Replay pipeline 段落补通用 isOptional 语义（元素短窗口未出现 → skip）。
- `README.md` / `README-zh.md`：REFINED 流程的登录分支结构与 select 参数化行为说明。
- `CHANGELOG.md`：先读 `docs/changelog-guide.md` 再写条目。
- 不编辑 `.bak`、`dist/`、`capture/capture.js`、`release/`。

---

## 5. 验证

按用户惯例**只跑构建与类型检查，不主动运行测试套件**：

```bash
npm run build
npx tsc --noEmit
```

手动场景（需要真实站点与 Pi 可用；如环境不具备，列出步骤交回用户验证）：

1. **结构检查**：未登录状态录制一个账密登录流程（含登录后业务操作）→ Stop → 等待 `ai:autoRefine` done → 打开 REFINED 孪生，确认结构为「打开系统（navigate + condition 网关）→ 登录（isOptional 凭据步骤 + assert）→ 业务组」，且凭据输入仍是 `{{input_N}}` / `{{password}}`。
2. **Reference 检查**：Reference 页出现全部 `input_N` / `select_N`（若有下拉框）/ `password` / `file_N`；无本次录制未使用的死变量。
3. **回放分支**：未登录回放 REFINED（走完整登录）；登录后再回放（网关直达业务组，登录步骤零执行或全 skip）。
4. **参数生效**：改 Reference 中某个 `input_N` 的值 → 回放 → 页面上出现新值。
5. **SSO（如有条件）**：分别以 未登录 / 过期 / 有效 三种状态回放，对照第 1 节表格。

---

## 6. 必须遵守的仓库约束（AGENTS.md 摘要 + 本次相关）

- `observed` 事实不可变；candidates/fingerprint/自愈输出才是可变解析数据。
- 所有 flow 写入必须过 Zod 解析与契约校验（本方案所有产出路径已走 `parseFlow`）。
- 密码值必须保持 `{{password}}` 模板（契约已强制）。
- 不得向渲染进程添加 Node API / Electron 对象；本方案**不改 renderer**。
- 不记录 cookie、密码、storage state、敏感流程变量到日志。
- 不破坏 `schemaVersion` 向后兼容（本方案无 schema 结构变化）。
- 不删除既有导出；`ai-refine.ts` / `run.ts` / `actions.ts` / `record.ts` 的现有导出全部保留。

## 7. 已知边界与刻意不做的事（防止范围蔓延）

- **网关是 0ms 快照**（`evaluateAssertion` 现状）：已登录但重定向慢时会误入登录组，由可选步骤自愈；**不要**为此给 condition 加等待窗口（留作后续优化）。
- **登录末尾 assert 固定 5s 轮询**（`runAssertion` 不读 `step.timeout`）：不改。
- 所有密码字段共用 `{{password}}`：不改。
- "点击哪个账号"是元素选择不是值参数：不做元素级参数化。
- 已有 REFINED 流程不重生成；`isMerged` 流程不二次细化（现状行为，保留）。
- 只在录制含登录段时生成登录结构；已登录态录制的流程不造登录分支（提示词已约束 "never invent login steps"）。
- advice / takeover 提示词不改。

## 8. 完成定义（验收清单）

- [ ] `npm run build` 与 `npx tsc --noEmit` 通过
- [ ] `config/prompts.json` 三处更新且应用启动时加载无错（无新增 key）
- [ ] `src/ai-refine.ts`：投影含 `isOptional`/`pageUrl`/`systemName`；元素库摘要含页面 URL；模板守卫（未知变量报错 + 孤儿剪除 + secret 丢失 risk）生效
- [ ] `engine/executor`：带 target 的 `isOptional` 步骤在元素短窗口未出现时记 skip；navigate 可选分支行为不变
- [ ] `engine/recorder`：单选 select 记为 `{{select_N}}` 并带 defaultValue
- [ ] schema 注释更新，schemaVersion 不变
- [ ] docs/architecture.md、README、README-zh、CHANGELOG 已更新
- [ ] 第 5 节手动场景已执行或已明确交回用户
