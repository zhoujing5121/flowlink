# Spec Delta

## MODIFIED Requirements

### Requirement: Rehydration SHALL accept only library references and validate before any persistence

Rehydration SHALL accept only `$ref` library references, and the rehydrated Flow SHALL pass schema validation before it is returned as a proposal.

未知 id 与内联元素对象被拒并点名违规步骤；库条目深克隆回填使 observed 证据逐字节还原；缺失步骤 id 生成、冲突加 `-2`/`-3` 后缀。校验经 `parseFlow`（含契约校验），变量自所有源合并、首个非密钥默认值胜出；模型可额外输出变量 label 表——机器键必须已在合并结果中存在（未知机器键拒绝），非空 label 覆盖启发式与旧值；模型亦可输出 variableActivities 建议表（机器键必须存在，未知分组 id 剔除），变量活动关联默认值以步骤模板使用证据推导优先、建议仅填充无使用证据的变量，落盘时清除自源继承的过期分组 id；模型还可输出 variableRules 规则建议表（机器键必须存在、未知键整次拒绝，非空自然语言文本覆盖旧值、确认界面可改）；其余 Reference 元数据（Mandatory/locator）不来自模型输出、按源 Flow 保留。校验后的 Flow 作为提案返回，此处从不落盘——持久化只经用户驱动的 `recording:persistMerged` 保存为全新录制（`isMerged: true`，永不覆盖既有录制，非法输出在持久化关口被拒）。

#### Scenario: 拒绝内联元素
- **WHEN** 模型输出携带内联元素对象
- **THEN** 重水化拒绝并点名违规步骤

#### Scenario: 证据逐字节还原
- **WHEN** 提案步骤重水化完成
- **THEN** 其 observed 证据与源录制逐字节一致

#### Scenario: label 合并
- **WHEN** 模型为机器键 `input_2` 输出 label「客户名称」
- **THEN** 合并后该变量 label 为「客户名称」，机器键与模板引用不变

#### Scenario: 未知机器键拒绝
- **WHEN** 模型 label 表中出现源 Flow 不存在的变量机器键
- **THEN** 生成被拒绝并点名该键，不产出半成品 Flow

#### Scenario: 规则建议合并
- **WHEN** 模型为某变量输出规则「必须是 11 位手机号」
- **THEN** 合并后该变量的规则文本为该建议，确认界面可改

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce nested multi-level business-stage grouping, plain-language labels, target-system tags, variable business labels, and verification/branching invariants.

录制后分组（generation.autoSanitize）与 Refine（generation.refine）输出嵌套多级分组：L1 业务级分组（按业务对象状态推进与可验证完成标志切分——出现独立交付物、业务对象状态变化或系统/人机交接时才切新组，2–6 个、动词+对象命名，每组完成标志以一行进入生成结果 `rationale`）内含 L2 技术级分组、L2 内为 L3 步骤；输出深度约束 ≤3 级、顶层必须业务级、简单流程可省 L2；L1/L2 分组按录制证据（URL/域名/系统名）提取 `targetSystem` 自由文本标签，证据不足时省略而不是编造。四层质量门：入口可达 → 已认证 → 目标内容可见 → 业务操作已生效（关键提交/确认/发送类操作后，仅当元素库存在结果证据时以 assert/expect 收尾验证，绝不发明结果元素）。登录段在任何生成指令下都无条件主动重构（不依赖指令是否提及登录）：入口导航 → 网关 condition（判定已位于目标页时 `trueStepId` 指向凭据段之后的首个业务步骤；分支缺省=顺序继续）→ isOptional 容忍式凭据/账号选择步骤 → 目标页断言收尾，全部并入首个业务阶段组，登录不单独成组。条件分支最小化：仅当分支影响后续处理时才创建 `condition`，录制证据未显示真实路径分叉时不新增。步骤标签非技术用户可懂；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle。录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板且机器键不可改名；模型 SHALL 依页面证据为每个模板变量输出业务 label（语言随源材料、动词短语优先、成对区间加 -开始/-结束 后缀），输出 variableActivities 建议表（按业务阶段与参数的使用关系把每个模板变量关联到其所属 L1 分组的 id；仅作默认值，使用证据优先），并输出 variableRules（依证据为每个模板变量用自然语言描述填写/校验规则——格式、取值范围、大小写、何时必填、是否自动计算等；语言随源材料，证据不足则留空不编造）；未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 嵌套分组输出
- **WHEN** 录制后分组处理一份跨两个业务阶段的录制
- **THEN** 产出 Flow 的顶层为两个 L1 业务级 group，各自包含 L2 技术级 group 与 L3 步骤

#### Scenario: 标签证据不足省略
- **WHEN** 录制证据无法支持某 L1 组的 targetSystem 判断
- **THEN** 该组不带 targetSystem 标签，生成不因此失败

#### Scenario: 按完成标志切组
- **WHEN** 源录制呈现可辨识的业务对象状态推进（如形成交付物、状态变化、跨系统交接）
- **THEN** 生成的顶层分组以这些可验证业务结果为切分边界，组名为动词+对象的业务行为短语

#### Scenario: 业务生效验证
- **WHEN** 关键提交/确认类操作之后元素库中存在结果证据（确认页、状态元素）
- **THEN** 提示词要求以库内证据对该业务结果收尾验证；库内无证据时不新增任何结果元素

#### Scenario: 分支最小化
- **WHEN** 录制证据未显示影响后续处理的真实路径分叉
- **THEN** 除登录网关外不新增 `condition` 分支

#### Scenario: 完成标志进入 rationale
- **WHEN** 一次生成成功返回
- **THEN** 每个顶层分组在 `rationale` 中有一行对应的完成标志说明（与组标签同语言）

#### Scenario: 默认指令也重构登录段
- **WHEN** 用户以不含任何登录措辞的默认指令对一份含 SSO 登录段的原始录制执行 Refine
- **THEN** 生成结果包含网关 condition 与容忍式凭据步骤（位于首个业务阶段组内），未登录会话可走完登录、已登录会话直达业务步骤

#### Scenario: 登录并入业务组
- **WHEN** 生成含登录段的流程
- **THEN** 结果中不存在独立的 Sign in 顶层组

#### Scenario: 变量业务命名
- **WHEN** 生成结果中存在证据充分的 `input_N` 变量
- **THEN** 每个模板变量都携带按证据给出的业务 label

#### Scenario: 规则证据不足留空
- **WHEN** 页面证据无法支持某变量的规则判断
- **THEN** variableRules 中该变量留空，生成不因此失败

#### Scenario: 规则证据不足留空
- **WHEN** 页面证据无法支持某变量的规则判断
- **THEN** variableRules 中该变量留空，生成不因此失败
