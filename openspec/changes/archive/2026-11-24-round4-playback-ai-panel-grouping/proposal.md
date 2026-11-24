# Proposal

## Why

第四轮真机验证暴露：rrweb 回放在应用内仍黑屏（数据侧已验证正常，问题在应用内播放器）；整页步骤截图被上轮砍掉后 Record 页失去按步画面；AI 面板交互与用户预期有偏差（Test 失败自动发消息、快捷菜单出现时机、勾选被输入重置、Refine 失败要看日志）；AI 分组仍按技术结构（登录独立成组）而非业务阶段，且 condition「必须组末 + 缺省分支=结束」的契约限制了业务化分组的表达。

## What Changes

- **rrweb 回放黑屏修复**：数据与 rrweb Replayer 已在隔离环境验证正常（跨 3 次导航 759 事件可完整渲染）；问题定位在应用内播放器的样式加载/舞台布局链路，需在应用内复现并修复（含防御性布局与量测重试）。
- **恢复整页步骤截图（screencast 版）**：录制时每个动作完成后经 CDP screencast 单帧采集整页图（与已上线的元素裁剪同机制，无闪烁投诉记录），Record 页截图墙恢复；保留 `FLOWLINK_DISABLE_RECORDER_SHOTS` 诊断开关；若真机仍闪，后续改走「按步定位 rrweb 回放」路线（不在本 change）。
- **Test 失败后 AI 交互重构**：移除失败后自动发送 AI 消息与 quickbar 独立 `AI Continue` 按钮；AI 面板快捷区新增「Analyze last failure」（点击才发失败上下文）与「AI Continue」（点击触发单步接管循环）两个预设快捷项，风格与现有快捷菜单一致。
- **AI 面板快捷菜单状态机**：进入 Process 等分析页不再自动显示 merge/generate/optimize 三快捷菜单；用户点击 Refine 按钮后才出现；选第三项 Optimize current flow 后才出现预设勾选+自由文本表单（merge/generate 选中走各自现有流程）。
- **Refine 指令消息呈现**：修复「先勾选再输入会重置勾选」bug；发送的消息以标签徽章（chips，可移除）+ 独立文本段呈现，提交时组装为多行结构化 instruction。
- **Refine 失败错误透出**：pi:generateFlow/repair 的完整错误信息直接显示在 AI 面板（含可展开详情），不再要求查日志。
- **业务分组与 condition 契约放宽**：
  - 提示词改为「登录/SSO 步骤并入首个业务阶段组（isOptional 容忍），不再独立成 Sign in 组」；
  - condition 允许出现在组内**任意位置**（不再强制组末）；
  - condition 分支缺省语义从「结束运行」改为**顺序继续**（不跳转，走组内下一步）；
  - 分支目标放宽为**同 Flow 内任意已存在步骤**（stepId 级，不再限于顶层组；防环护栏沿用按顶层组的访问计数）；
  - 存量兼容：用户将自行删除既有 flow，本 change 不做迁移（schema 字段语义变更视为 breaking，已在 What Changes 标注）。
- **Refine 失败原因调查**：除错误透出外，须以用户实际启动方式（含代理参数）复现当前 `pi:generateFlow` 失败，定位失败环节（代理不可达 / 超时 / 输出解析）并修复或给出配置指引。
- **规格清理**：ai-integration 中「Auto-refine SHALL create a REFINED twin」需求已被第三轮变更废除（停止自动 REFINED + 提案制），随本 change 一并从主 spec 移除。

## Capabilities

### New Capabilities

（无——全部落在既有能力上）

### Modified Capabilities

- `renderer-ui`: AI 面板快捷区状态机（三菜单改由 Refine 按钮触发、Optimize 二级表单、失败预设项、chips 消息、勾选状态保持）；Record 页步骤截图墙恢复；rrweb 播放器在应用内正常渲染（布局/量测契约）。
- `recording`: 录制会话在动作完成后采集整页步骤截图（CDP screencast 单帧、无闪烁、可整体禁用）。
- `replay-execution`: condition 路由语义——组内任意位置可判定；分支缺省=顺序继续；跳转目标为任意已存在步骤（stepId 级）；沿用有界重试与按组访问上限。
- `flow-schema`: condition 契约放宽（不强制组末、缺省分支顺序继续、目标为同 Flow 内任意已存在步骤；**BREAKING**：分支字段语义由组 ID 变为步骤 ID，存量 flow 由用户删除、无迁移）。
- `ai-integration`: 生成提示词的业务分组不变量（登录并入首个业务阶段组）；移除已废的 Auto-refine 需求；Refine 失败返回完整错误供面板展示。

## Impact

- 代码：`renderer/app.js|index.html|app.css`（AI 面板/快捷区/Record 页/播放器）、`engine/recorder/src/record.ts|capture-client.ts`（整页截图 screencast 化）、`engine/executor/src/run.ts`（condition 语义）、`engine/schema/src/schema.ts`（契约）、`renderer/flow-graph.js`（决策节点任意位置/缺省边）、`src/ai-refine.ts` 与 `config/prompts.json`（分组不变量）、`src/main.ts`（错误信息透出、IPC 如需）。
- 兼容：condition 缺省语义变更对存量无影响（已扫描 0 个 condition）；新录制产出 `record/screenshots` 目录（旧数据兼容展示不变）。
- 参考：`docs/investigation-recording-flicker-step-types-instruction-takeover.md`、`docs/plan-round3-fixes.md`、`AGENTS.md` invariants。
- 验证：build + tsc；黑屏修复与截图墙需真机验证。

## Out-of-Scope

- Process 连线按类型着色（用户已列后续项）。
- Instruction 页面重构（用户已明确后续单独做）。
- condition 的 stepId 级跳转、数据驱动循环。
- 「按步定位 rrweb 回放」替代截图的路线（仅当 screencast 整页截图真机仍闪烁时再立项）。
- Test 失败后的任何自动 AI 分析/自动接管（本 change 只做用户点击的预设项）。
