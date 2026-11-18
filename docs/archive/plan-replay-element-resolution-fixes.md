# 修改方案:回放元素解析可靠性修复(基于 5 次真实回放失败的解剖)

> 性质:实施方案文档。**2026-11-15 已实施 A/B/D(PR1 全部)与 A4;方案 C 刻意不做**——
> 回放保持失败即结束,由用户在 Test 面板手动点「Run remaining steps with AI」转交给
> browser-use 接管(既有 `playback:aiContinue` 链路),不向 `playOnPage` 注入 L4 repair。
> 依据 2026-11-15 对本机全部回放报告的解剖结论。
> 基线 commit:`2f24788`(master)+ 工作区未提交的登录分支/参数化改动。
> 原则:**不改 schemaVersion、不动 `observed` 不可变契约、不破坏 recorder/executor 现有导出**。

---

## 0. 背景与证据

用户报告"从来没有成功复现过一次录制流程"。解剖 `%APPDATA%\flowlink\flowlink\artifacts\` 下全部 5 份 run 报告(`result.json`),结论:

| run | 失败步骤 | 错误码 | 场景 |
|---|---|---|---|
| flow_mwhgfqwe ×2 | g3/s18 click `<button>` | AMBIGUOUS | OutSystems「关闭提示窗口」按钮 |
| flow_mweahftm | g2/s12 click `<button>` | AMBIGUOUS | 同站另一按钮 |
| flow_mwedjigq | g1/s5 click `<div>` | AMBIGUOUS | 疑似 SSO 账号选择瓷贴(flow 文件已删,未能完全核实) |
| flow_mwenbiz1 | g2/s12 click `<a>` | NO_MATCH | 博世公网故事链接(轮播内容,回放时不在页面) |

**5 次全部死在元素解析,没有一次死在导航、expect 校验或 NO_EFFECT。** 典型证据(s18「关闭」按钮的 IR):

- 候选**只有一个**:24 层深的绝对 xpath `/html/*[2]/*[1]/*[1]/*[1]…`;
- 指纹 attrs 只有 `{type: "button"}`,无 role、无 accessibleName;
- 录制矩形 x=2298,超出视口宽 1459(元素渲染在视口外)。

回放时:xpath 0 命中(DOM 变了)→ L2 指纹池 = 全页所有 `button[type=button]` → 几何消歧因录制坐标失真而分差不足 → AMBIGUOUS。

### 根因链(逐条对应代码)

1. **录制期候选校验"全 DOM 唯一"过严**:`engine/recorder/src/capture-client.ts:347` —— `count > 1` 即整条淘汰。录制瞬间 DOM 里的隐藏副本/通知堆栈让 `text:"关闭"`、role 候选全部被扔掉,唯一幸存的是"按构造必然唯一"的 nodePath xpath。且因 xpath 校验通过(`validation==='ok'`),连"候选未经校验"的 description 标注都不触发。
2. **回放端消歧不区分可见性**:`engine/resolver/src/l1.ts:108-149` 多命中时对**全部**命中(含隐藏模板副本)做几何排序;`engine/resolver/src/fingerprint.ts:128-142` L2 同样对全池排序,`visible` 字段采集了(`hash.ts` InPageCandidate)却只在选出 winner 之后才检查。隐藏副本的矩形全是 (0,0,0,0) 或与真身并列,几何分差必然不足。
3. **指纹卫生问题**:`engine/recorder/src/element.ts:141-151` 的属性策略是"以 `data-` 开头就收",把 knockout 的 `data-bind`(多行框架内部标记)收进了指纹;反过来,元素文本("关闭")完全没进指纹——ariaSnapshot 拿不到 name 时指纹近乎空白。
4. **L4 AI 兜底有代码、无调用方**:`engine/executor/src/run.ts:370-439` 整套 repair 适配器(ariaSnapshot→getByRef→normalize,含导航失效重试)已实现,但 `src/main.ts:1299` 的 `playback:run` 调 `playOnPage` 时不传 `ai`,`RepairClient`(`engine/executor/src/types.ts:26`)在 `src/` 下零实现。NO_MATCH 案例(动态内容)唯一可能的救命稻草从未生效。

### 为什么不是重新设计数据结构

三案例都能在现有 IR 内修复;schema 的"observed 证据 + candidates 阶梯 + fingerprint"结构与 Chrome DevTools Recorder / Testim / Mabl 的自愈模型同构,多级降级路径(L1→L2→L4、isOptional、自愈写回)正是为这些失败准备的——问题在于最强的几条降级路径(语义候选、可见性、AI)被实现细节堵死了。推翻 schema 不解决任何一例,还会丢掉证据链与 AI 细化的 `$ref` 协议。

---

## 1. 方案总览

| 方案 | 解决的失败 | 主要文件 | 预期杠杆 |
|---|---|---|---|
| A. 录放统一「可见唯一」语义 | AMBIGUOUS ×4(s18 类) | capture-client.ts / l1.ts / fingerprint.ts | 最高:直接命中 4/5 次失败 |
| B. 指纹卫生 + 语义回填 | 指纹空白/data-bind 污染 | element.ts / hash.ts / record.ts | 配合 A 显著缩小 L2 池 |
| C. AI 兜底接入 App 回放 | NO_MATCH(动态内容) | main.ts / 新 src/ai-repair.ts | 覆盖静态定位无解的场景 |
| D. 弱候选落盘告警 | 防患于未然 | record.ts(复用已有 schema 字段) | 顺手,零 schema 变化 |

依赖关系:A 与 B 同片代码建议一起做(一个 PR);C 完全独立;D 顺手。

---

## 2. 方案 A:录制/回放统一「可见元素中唯一」语义

### A1 录制期校验(capture-client.ts `validateCandidate`)

现状(第 333-364 行):`count()===1` 才继续可见性与 uid 身份校验;`count>1` 直接 `'ambiguous'` 淘汰。

改法:`count > 1` 时不再立即淘汰,改为取全部命中的 `{visible, owned}` 再判定:

```ts
if (count > 1) {
    // 隐藏副本(模板/堆叠通知)不参与唯一性判定:
    // 真实页面上「可见元素中唯一」就是可回放的唯一性。
    const flags = await locator.evaluateAll((els, want) =>
        els.map((el) => {
            const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean }
            let visible = false
            if (typeof anyEl.checkVisibility === 'function') {
                try { visible = anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) }
                catch { visible = el.getClientRects().length > 0 }
            } else visible = el.getClientRects().length > 0
            return { visible, owned: el.getAttribute('data-rr-uid') === want }
        }), uid)
    const visibleOnes = flags.filter((f) => f.visible)
    if (visibleOnes.length === 1 && visibleOnes[0]!.owned) return 'ok'
    if (visibleOnes.length === 1 && !visibleOnes[0]!.owned) return 'ambiguous' // 唯一可见的是别的元素
    if (visibleOnes.length === 0) return 'missing'                             // 全部隐藏
    return 'ambiguous'                                                          // 多个可见,仍拒绝
}
```

- 单命中路径(count===1)保持不变。
- `checkVisibility` 与 resolver/hash.ts:332-342 的 `isVisible` 语义一致(off-screen 但已渲染的元素仍算可见——s18 那个 x=2298 的视口外按钮不会被误杀)。
- `getByText` 等模糊候选在「多个可见」时依旧拒绝,保守性不降级。

**效果(s18 案例)**:`text:"关闭"` 3 命中、1 可见且 owned → `'ok'`,以 score 70 进入 IR 排在 xpath(900)之前。回放时 L1 先试文本候选。

### A2 回放端 L1(l1.ts)

现状:`rectsOf`(第 40-47 行)只返回矩形;第 108-149 行多命中分支对全部命中几何排序。

改法:`rectsOf` 改为返回 `{ rect, visible }`(同上 evaluateAll + checkVisibility);多命中分支先过滤:

```ts
const visibleOnes = indexed.filter((it) => it.visible)
if (visibleOnes.length === 1) {
    // 多命中但只有一个可见:隐藏副本不参与竞争
    return winner(visibleOnes[0])   // 复用现有可见性检查与返回结构
}
// 0 个可见 → 记 sawHidden 继续;多个可见 → 对 visibleOnes 做现有几何消歧(15% 门槛不变)
```

几何消歧的排序对象从「全部命中」改为「可见命中」;15% 分差门槛、拒绝猜测语义全部保留。

### A3 回放端 L2(fingerprint.ts)

现状:第 128-142 行对全池 `rankMatches`;第 165-172 行选出 winner 后才查 `visible`。

改法:排序前先做可见性预过滤:

```ts
const visiblePool = pool.filter((c) => c.visible)
const effective = visiblePool.length > 0 ? visiblePool : pool
// rankMatches(effective, ...);原有 winner 可见性检查保留(防御性)
if (visiblePool.length > 0 && visiblePool.length < pool.length) {
    log(`L2 预过滤:${pool.length} 个精确候选中 ${pool.length - visiblePool.length} 个不可见,已剔除`)
}
```

全池不可见时保留原行为(winner 可见性检查会以 HIDDEN 失败,语义不变)。

### A4(顺手)`waitForAnyCandidate`(resolver/index.ts:118)

轮询条件从 `count() > 0` 改为「存在可见命中」,与新 L1 语义一致,避免等出一个"存在但全隐藏"的假就绪。

### 方案 A 的风险与边界

- **录放两侧必须同步改**,否则违反 element.ts 注释里"录放语义不漂移"的核心原则:录制期按可见唯一收录的候选,回放期必须同样按可见唯一解析,否则收录即埋雷。
- 两个可见命中时仍走几何消歧,不降低保守性;选错风险与现状持平(现状是直接失败)。
- 全部改动为解析策略,不触 IR 结构、不触发 schemaVersion 变化。

---

## 3. 方案 B:指纹卫生 + 语义身份回填

### B1 属性白名单收紧(element.ts + hash.ts 同步)

现状:element.ts:141-151 `pickFingerprintAttrs` 放行任意 `data-*`;hash.ts:50-54 `STABLE_ATTR_POLICY` 同样 `allowPrefix: ['data-']`。knockout `data-bind`(多行)被收进指纹。

改法(两侧同步,`stablehash.compat.test.ts` 跨包回归测试保证一致性):

1. **deny 名单**(按属性名):`data-bind`、`data-reactid`、`data-v-*`(vue scoped)、`ng-*` 前缀——框架内部标记,不是元素身份;
2. **值级守卫**(扩展 `isDynamicValue`,三处同步:element.ts / hash.ts / hash.ts 页内副本):含换行符的值一律视为非稳定标识(实测 data-bind 的值带 `\n`)。

### B2 语义身份回填(record.ts 三处 merged 构造点)

现状:ariaSnapshot 拿不到 name/role 时(瞬时 toast、崩溃边缘页面),fingerprint 的 `accessibleName`/`role` 为空,指纹近乎退化。s18 的指纹只有 `{type:"button"}` 而"关闭"两个字就在眼前。

改法:element.ts 新增纯函数:

```ts
/** ariaSnapshot 失败时的语义兜底:原生可访问名的近似(tag→隐式 role;文本→name) */
export function backfillRoleName(facts: RawElementFacts): RawElementFacts {
    const role = facts.role ?? facts.attributes['role'] ?? implicitRoleOfTag(facts.tag, facts.attributes)
    const name = facts.accessibleName
        ?? (facts.text && facts.text.length <= 80 ? facts.text : undefined)
    return { ...facts, role, accessibleName: name }
}
```

- `implicitRoleOfTag`:小型映射表(button→button、a[href]→link、input 按 type、h1-h6→heading、li→listitem 等;与 hash.ts:251-294 页内 `implicitRole` 语义对齐,录制侧持有一份文档化副本)。
- record.ts 在三处 `merged` 构造点调用(`buildRefFor`、`buildRefFromUid`、`buildFrameAnchor`),**必须在 `deriveCandidates(merged)` 之前**——role+name 候选(score 30)的生成依赖这两个字段。
- 效果:s18 新录制的指纹变为 `role=button, accessibleName="关闭"`;L2 的 `matches()`(hash.ts:344-359)按 name 全等过滤,池从"全页按钮"缩到"名为关闭的按钮"。

### B3 兼容性(旧 flow 不回归)——必须处理的一个坑

L2 页内 `matches()` 目前用 `stableAttrs(el)`(**当前策略过滤后**)与 flow 指纹逐项全等。若策略收紧,旧 flow 指纹里的 `data-bind` 在回放侧被过滤掉 → `live[key] === undefined ≠ 录制值` → 旧 flow 的 L2 意外回归。

改法(配套):`matches()` 对 flow 提供的 key **直接读元素原始属性**(`el.getAttribute`),绕过策略过滤;策略只决定「哪些属性进入新录制的指纹」与「hash 重算用的 attrs 上报」。这样:

- 旧 flow:`data-bind` 原值逐项全等依旧成立(data-bind 本身是稳定标记,只是无区分度),L2 不回归;
- 新 flow:deny 名单让它根本进不了指纹。

注意键名大小写:hash.ts 采集侧小写化属性名,`getAttribute` 大小写敏感,比较需按小写归一。

### 风险与边界

- B1 改变 stableHash 的输入 → 只影响**新录制**的指纹值;旧 flow 的 hash 与新策略重算值可能不一致 → L2 自动落到 attrs 全等回退策略(B3 保证其可用),行为与现状相同,不算回归。
- B2 的文本回填只在 ariaSnapshot 缺名时生效;`MAX_TEXT_CANDIDATE = 80` 上限防长文本进指纹。
- 三处 `isDynamicValue` 副本(element.ts / hash.ts / 页内序列化副本)必须逐字节同步,跨包回归测试会兜底。

---

## 4. 方案 C:AI 兜底接入 App 内回放(L4)

### 现状

- executor 侧完整实现:`run.ts:370-439` repair 适配器(仅 `mode:'ai'` 快照、getByRef→立即 normalize、导航失效重试一次、closed shadow 跳过、expect 校验不带 AI 防止"修成通过")——全部护栏已在。
- App 侧零接入:`main.ts:1299` `playOnPage({...})` 不传 `ai`;`RepairClient` 无任何实现。
- Pi 基础设施现成:`src/pi-agent.ts` / `src/pi-agent-worker.ts`(worker 线程,主线程不阻塞)、`config/prompts.json` 模板加载、`config/pi-settings.json` 开关。已知约束:模型端点仅代理可达;嵌套 pi-ai 必须 external。

### 改法

1. **新建 `src/ai-repair.ts`**:实现 `RepairClient.locate(input)`,内部复用 pi-agent worker:
   - 输入映射:`RepairInput { url, target, ariaSnapshot, candidates }` → 组装一次性定位提示词(新模板键 `repair.locate`,`src/prompts.ts` 的 `loadPromptTemplates` 增加 requireString 校验);
   - 输出解析:模型返回 `{ ref, confidence, reason }` JSON(复用 `ai-refine.ts` 的 `extractJsonObject` 思路);解析失败返回 `null`(resolver 侧已有"AI 未能给出定位"降级路径);
   - 护栏:单次 run 调用上限(建议 10 次,`pi-settings.json` 可配 `repairMaxCalls`)、单次超时(建议 20s)、总开关 `aiRepair: true/false`(默认 true,符合本项目 AI-oriented、免手工配置的取向)。
2. **main.ts `playback:run` 注入**:`playOnPage({ ..., ai: repairClient })`(仅当 Pi 可用;不可用时照旧不传,日志一行"L4 AI 兜底未启用")。
3. **预算可见**:`playback:done` 结果里带 `repairCalls` 计数,UI 可后续展示。

### 为什么直接注入而不是"失败前触发一次"

resolver 的调用时机本身就是"L1+L2 全部失败之后"——常规注入即等价于失败兜底,不需要额外的失败前钩子;closed shadow 跳过、expect 不带 AI、验证唯一且可见(`validateAiLocator`)这些既有护栏全部继续生效。实现成本最低,行为可预测。

### 效果

案例 3(轮播故事链接,回放时不在页面)在 A/B 无解——内容真的不在;L4 用 ariaSnapshot 全页语义找"同一故事的另一个入口/等价链接",是唯一出路。同时它顺带兜住所有"DOM 结构漂移导致 xpath 失效"的长尾。

---

## 5. 方案 D(小):弱候选落盘告警,复用已有字段

`BaseStepSchema` 已有 `reviewRequired` / `reviewReason`([schema.ts:168-170](../../engine/schema/src/schema.ts))——**当前没有任何代码写入这两个字段**。

改法:record.ts 成步时,若 target 的幸存候选全部 `score >= 300`(即只剩 css 路径/xpath 级别,没有语义候选),写:

```ts
step.reviewRequired = true
step.reviewReason = '元素缺少语义候选(无 testid/role/label/text),仅靠结构定位,回放脆弱'
```

- s18 类问题在录制当场就会被标出来,而不是回放失败后考古;
- UI/REFINED 生成侧可读该标记(prompt 投影字段 `BASE_FIELDS` 顺带加上),人工复核有抓手;
- 零 schema 变化(字段已存在),零回放行为变化。

---

## 6. 实施顺序

```
PR1(同片代码,一次改完):
  A1 capture-client.ts validateCandidate 可见唯一
  A2 l1.ts 多命中可见性预过滤
  A3 fingerprint.ts L2 池可见性预过滤
  A4 resolver/index.ts waitForAnyCandidate 可见就绪
  B1+B3 element.ts / hash.ts 属性策略 + matches() 原始读值
  B2 element.ts backfillRoleName + record.ts 三处调用
  D  record.ts reviewRequired 落盘
PR2(独立):
  C  src/ai-repair.ts + prompts.json(repair.locate)+ main.ts 注入 + pi-settings 开关
```

文档更新(实现时按 AGENTS.md):`docs/architecture.md` 录制管线/Replay pipeline 补「可见唯一」语义与 L4 注入说明;README/README-zh 提 AI 兜底开关;CHANGELOG 按 `docs/changelog-guide.md`。

## 7. 验证

按仓库惯例只跑构建与类型检查,不主动运行测试套件:

```bash
npm run build
npx tsc --noEmit
```

手动场景(需要真实站点):

1. **AMBIGUOUS 回归**:在 OutSystems 废品交易页重录「关闭提示窗口」流程 → 检查新 flow:目标候选含 `text:"关闭"`(或 role 候选)且排在 xpath 前、指纹含 `accessibleName:"关闭"` → 回放两次,该步应 L1 命中;
2. **旧 flow 不回归**:用现存 REFINED 流程(flow_mwhgfqwe,指纹含旧策略产物)回放一次,L2 日志应显示 attrs 全等路径行为不变;
3. **L4 生效**:博世公网故事页流程回放,打开 Pi 可达的环境,确认失败步骤日志出现 `L4 AI 兜底命中` 或至少 `L4 失败` 的真实调用记录(而非"L4 跳过:未注入");
4. **预算护栏**:同一 run 内 L4 调用不超过上限,`pi-settings.json` 关闭开关后回放日志出现"未启用"。

## 8. 非目标(刻意不做)

- 不改 `schemaVersion`,不新增 schema 字段(D 用的字段已存在);
- 不动 `observed` 不可变契约与 candidates 升序契约;
- 不给 condition 评估加等待窗口、不让 assert 读 `step.timeout`(登录分支交接文档的既有边界);
- 不重录/重新生成已有 REFINED 流程;
- 不做元素级参数化;
- expect 推断(签名采样)与 NO_EFFECT 探测本轮不动——5 次失败无一例由此引起,先修实锤。
