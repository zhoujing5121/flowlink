# Spec Delta

## MODIFIED Requirements

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce business-stage grouping, plain-language labels, and verification/branching invariants.

强制 2–6 个带标签顶层**业务阶段**分组与非技术用户可懂的步骤标签；**登录/SSO 步骤并入首个业务阶段组**（入口导航后跟可选网关条件：已进入目标页则跳到后续业务组，未进入则顺序执行组内容忍式凭据/账号选择步骤，isOptional 容忍已登录与记忆式 SSO，组尾以目标页元素断言收尾），登录不再独立成组；条件步骤可位于组内任意位置，缺省分支表示顺序继续；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle；录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板，未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 登录并入业务组
- **WHEN** 生成含登录段的流程
- **THEN** 结果中不存在独立的 Sign in 顶层组；入口导航、网关条件、容忍式凭据步骤与收尾断言同属首个业务阶段组

## REMOVED Requirements

### Requirement: Auto-refine SHALL create a REFINED twin without touching the source recording
**Reason**: 第三轮变更（round3）已停止录制结束自动生成 REFINED：细化只在用户于 AI 面板主动触发时发生；针对已有 REFINED 记录的 AI 更新走提案制（proposal + 前后对比 + Apply/Discard），不再另存孪生。主规格未随该轮同步，随本 change 一并移除。
**Migration**: 无迁移——行为已于 round3 上线（`autoRefine` 配置与触发链路已删除）；存量 REFINED 记录共存不迁移。

## ADDED Requirements

### Requirement: Generation failures SHALL surface full error text to the AI pane

细化/修复生成失败时，主进程 SHALL 把完整错误信息（含失败阶段与原因细节）随结果返回，AI 面板 SHALL 直接展示完整错误文本（可折叠详情），不要求用户查看日志文件。

#### Scenario: 生成失败展示
- **WHEN** 用户触发的 Refine 因模型输出无效而失败
- **THEN** AI 面板显示完整错误信息（含解析/校验失败原因），原始流程未被改动
