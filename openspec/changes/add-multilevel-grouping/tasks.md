# Tasks

## 1. Schema 契约与执行器回归

- [ ] 1.1 `engine/schema/src/schema.ts`：group 新增可选 `targetSystem` string 字段；契约校验升级——组/步骤 id 全 Flow 命名空间唯一（重复拒绝）、空组拒绝、嵌套任意深度接受并原样持久化、分支目标存在性覆盖嵌套深度。验证：node:test 永久回归（嵌套落盘/重复 id 拒绝/空组拒绝/标签持久化/无标签合法/旧扁平数据兼容）全绿。
- [ ] 1.2 执行器回归锁定（代码零改动）：node:test 覆盖嵌套扁平化前缀 stepId、条件目标任意深度解析、循环上限按最外层拥有分组计数。验证：npm test 新增用例全绿，engine/executor 无行为代码改动（diff 确认）。

## 2. 层级编号

- [ ] 2.1 `renderer/flow-graph.js` 新增 `numberingOf(flow)` 纯函数（树位置 → `01`/`01-01`/`01-01-01`…），替换 `ensureProcessGroups` 现有编号逻辑；Process 组卡、Instruction 组卡/步骤行、Test 列表三处接入。验证：扁平数据编号与现状一致；嵌套数据三处编号一致（node:test 覆盖编号派生含 >3 级延伸）。

## 3. AI 生成契约多级化

- [ ] 3.1 `config/prompts.json`：generation.autoSanitize 与 generation.refine 输出契约改为嵌套多级（L1 2–6 个业务级、L2 可选、深度 ≤3、顶层业务级），L1/L2 组按录制证据提取 targetSystem（证据不足省略）；沿用完成标志切组与四层质量门。验证：审读 diff 既有纪律未丢失；node:test 校验生成输出 schema（嵌套深度/顶层组数/标签字符串化/畸形拒绝）。

## 4. 渲染层适配

- [ ] 4.1 Process 画布嵌套渲染：`buildGraph` 推导嵌套分组节点（外层组卡包含内层组卡），边按执行语义连接；扁平数据渲染不变。验证：嵌套 Flow 打开呈现层级节点，边语义正确（真机）。
- [ ] 4.2 Instruction 嵌套组卡：`index.html` 模板递归填充、内层默认折叠、组卡头 targetSystem 展示与编辑（flow:updateSteps 落盘）。验证：编辑标签落盘重载仍在；嵌套卡折叠展开正常（真机）。
- [ ] 4.3 菜单守卫：删除含子孙分组加确认（列影响步骤数）并连带清理受影响分支引用；插入/移动/重录/加节点目标选择支持嵌套层级。验证：删除嵌套组后 Flow 校验通过且无悬空分支引用（真机 + 手工构造用例）。

## 5. 收尾验证

- [ ] 5.1 Refine 对比视图与录制后分组在多级数据上的呈现（复用渲染器）。验证：对一份多阶段录制跑 refine，产出顶层 L1 嵌套结构且画布/对比视图正确呈现（真机）。
- [ ] 5.2 `npm run build` + `npx tsc --noEmit` + `npm test` 全绿（收尾验证任务）。
- [ ] 5.3 真机验证：旧扁平 Flow 兼容、AI 生成多级 Flow（编号/嵌套卡/标签编辑落盘）、删除嵌套组确认与清理、三处编号一致。验证：用户确认走查清单。
