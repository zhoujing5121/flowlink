# Spec Delta

## MODIFIED Requirements

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce business-stage grouping, plain-language labels, and verification/branching invariants.

强制 2–6 个带标签顶层**业务阶段**分组与非技术用户可懂的步骤标签；**登录段在任何生成指令下都无条件主动重构**（不依赖指令是否提及登录）：入口导航 → 网关 condition（判定已位于目标页时 `trueStepId` 指向凭据段之后的首个业务步骤；分支缺省=顺序继续）→ isOptional 容忍式凭据/账号选择步骤（适配已登录、过期、记忆式 SSO）→ 目标页断言收尾，全部位于首个业务阶段组内，登录不单独成组；condition 可位于组内任意位置。登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle；录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板，未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 默认指令也重构登录段
- **WHEN** 用户以不含任何登录措辞的默认指令对一份含 SSO 登录段的原始录制执行 Refine
- **THEN** 生成结果包含网关 condition 与容忍式凭据步骤（位于首个业务阶段组内），未登录会话可走完登录、已登录会话直达业务步骤

#### Scenario: 登录并入业务组
- **WHEN** 生成含登录段的流程
- **THEN** 结果中不存在独立的 Sign in 顶层组
