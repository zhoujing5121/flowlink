# Spec Delta

## MODIFIED Requirements

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce nested multi-level business-stage grouping, plain-language labels, target-system tag extraction, and verification/branching invariants.

录制后分组（generation.autoSanitize）与 Refine（generation.refine）输出嵌套的多级分组结构：L1 业务级分组（外层 group，按业务对象状态推进与可验证完成标志切分，2–6 个、动词+对象命名、每组 rationale 写完成标志）内含 L2 技术级分组（现有 group 粒度）、L2 内为 L3 步骤；输出深度约束 ≤3 级、顶层必须业务级、简单流程可省 L2。L1/L2 分组同时按录制证据（URL/域名/系统名）提取 `targetSystem` 自由文本标签，证据不足时省略标签而不是编造。既有纪律不变：非技术用户可懂的步骤标签；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再结构性元素）而非易变录制数据；慢过渡后检查 `timeout` 指引、可为首步标注 settle；登录段门条件 + 容忍式登录组适配已登录/过期/记忆式 SSO；录制值参数保留为模板；`$ref` 元素纪律与四层质量门保留。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 嵌套分组输出
- **WHEN** 录制后分组处理一份跨两个业务阶段的录制
- **THEN** 产出 Flow 的顶层为两个 L1 业务级 group，各自包含 L2 技术级 group 与 L3 步骤

#### Scenario: 标签证据不足省略
- **WHEN** 录制证据无法支持某 L1 组的 targetSystem 判断
- **THEN** 该组不带 targetSystem 标签，生成不因此失败
