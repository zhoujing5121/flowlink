# 画布重构三 Change 统一真机验证清单（2026-11-22）

三个 OpenSpec change（A `refactor-process-canvas-x6`、B `add-multilevel-grouping`、C `add-swimlane-and-level-views`）已全部实现并通过主会话独立核查：`npm run build` ✓、`npx tsc --noEmit` ✓、`npm test` 86 过/0 败/1 跳过（1 跳过为 refine 套件既知）、`openspec validate` 三个 change 全部 valid。改动未提交（工作区 17 文件 +3298/-633 与 2 个新测试文件）。

启动应用：`npm run dev`（或 `npm start`）。建议准备三类数据：①纯录制旧 Flow ②多源 AI 合并 Flow ③跨多业务阶段录制（用于 refine 生成多级）。

## 一、Change A：X6 画布行为对等（任务 3.2）

- [ ] **A1 纯录制 Flow**：布局正确、缩放/平移/fit 正常、分组菜单（Re-record/Add before/Add after/Delete）、步骤右键菜单可用
- [ ] **A2 多源合并 Flow**：并行链各自 Start/End、`meta.sourceFlows` 着色 + 图例
- [ ] **A3 条件分支 Flow**：菱形判定节点、是/否标签边、虚线回跳边；跑一次回放——走过边高亮、未走分支变暗、组描边绿/红/灰实时刷新；跑一次 Refine——并排前后对比视图正常
- 已知可接受差异（非 bug）：标签芯片略紧、vendor 缺失时只报错不堆卡、右下角新增小地图（minimap）

## 二、Change B：多级分组（任务 5.3）

- [ ] **B1 旧扁平 Flow 兼容**：打开/编辑/回放行为不变；注意**可见变化**：步骤编号从 `01-001` 收敛为 `01-01`（层级编号规范，三处页签一致）
- [ ] **B2 AI 多级生成**：对多阶段录制跑 Refine/录制后分组——产出顶层 L1 业务组（2–6 个）嵌套 L2 技术组的结构，组名业务化、rationale 带完成标志、targetSystem 标签来自 URL/域名证据（证据不足的组无标签）
- [ ] **B3 三处编号一致**：同一嵌套 Flow 的 Process / Instruction / Test 显示相同层级编号（01 / 01-01 / 01-01-01，>3 级自然延伸）
- [ ] **B4 Instruction 嵌套组卡**：L2 内层默认折叠、展开正常；组卡头 targetSystem 行内编辑→保存→重新加载仍在
- [ ] **B5 删除嵌套组**：删除含子孙的 L1 组弹出确认（列影响步骤数）；确认删除后 Flow 校验通过、无悬空条件分支引用
- [ ] **B6 分组操作嵌套目标**：插入后继/移动/分组重录/加节点的目标选择能选到嵌套层级内的组
- [ ] **B7 旧数据 id 冲突（可选）**：如打开含重复 id 的历史 Flow，加载正常，保存时才报冲突并列出 id

## 三、Change C：级别切换与泳道（任务 3.3）

- [ ] **C1 工具栏**：Flow | Swimlane 视图菜单（radio）；Expend/Collapse 开关展开卡内明细；切换视图后缩放/fit 与开关状态保持；状态不落盘（重开任务后回默认）
- [ ] **C2 级别切换器**：编号图例位置可点击，枚举 Flow 实际深度（嵌套数据出 01_Activity/01-01_Task/01-01-01_Action 段，扁平数据只出 01-01_Task）；切换后节点粒度与边聚合正确（L1/L2 视图边 = 下级聚合，保留实线/条件/回跳样式）
- [ ] **C3 下钻/返回**：双击分组节点进入下一级 + 面包屑返回
- [ ] **C4 扁平数据退化**：旧 Flow 默认 L2 视图（与现状等价）、级别切换器无 L1 段
- [ ] **C5 泳道布局**：列 = targetSystem（出现序 + 「未标注」兜底列，缺标签不报错不隐藏）、行 = L1 阶段带；条件分支兄弟 L1 组合并为一条带（如 03–05）+ 分支标题；任务卡（L2 组卡/扁平步骤卡）落入对应系统列；执行顺序箭头、Start/End 端点
- [ ] **C6 回放 overlay**：L1 视图任一子孙失败→L1 节点红、全跳过→灰；Swimlane 视图任务卡高亮、未走分支连线变暗
- [ ] **C7 组合走查**：多级 Flow 上视图切换 × 级别切换 × 下钻 × Expend 组合操作，无状态错乱

## 验证完成后

1. 勾掉三个 change tasks.md 的最后未勾项（A 3.2 / B 5.3 / C 3.3）
2. commit 由你主导（建议按 change 分三次提交，或一次整体提交）
3. 归档：`openspec archive`（B/C 的 delta 会合入主 specs；A 无 delta）
4. 发现问题直接反馈，由主会话派发修复（注明 A/B/C 哪一层的问题最有效）
