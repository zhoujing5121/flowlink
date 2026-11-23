# Spec Delta

## MODIFIED Requirements

### Requirement: Rehydration SHALL accept only library references and validate before any persistence

Rehydration SHALL accept only `$ref` library references, and the rehydrated Flow SHALL pass schema validation before it is returned as a proposal.

未知 id 与内联元素对象被拒并点名违规步骤；库条目深克隆回填使 observed 证据逐字节还原；缺失步骤 id 生成、冲突加 `-2`/`-3` 后缀。校验经 `parseFlow`（含契约校验），变量自所有源合并、首个非密钥默认值胜出；模型可额外输出变量 label 表——机器键必须已在合并结果中存在（未知机器键拒绝），非空 label 覆盖启发式与旧值；模型亦可输出 variableActivities 建议表（机器键必须存在，未知分组 id 剔除），变量活动关联默认值以步骤模板使用证据推导优先、建议仅填充无使用证据的变量，落盘时清除自源继承的过期分组 id；其余 Reference 元数据（必填/校验）不来自模型输出、按源 Flow 保留。校验后的 Flow 作为提案返回，此处从不落盘——持久化只经用户驱动的 `recording:persistMerged` 保存为全新录制（`isMerged: true`，永不覆盖既有录制，非法输出在持久化关口被拒）。

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

### Requirement: Generation prompts SHALL enforce grouping and verification invariants

Generation prompts SHALL enforce business-stage grouping, plain-language labels, and verification/branching invariants.

强制 2–6 个带标签顶层业务分组与非技术用户可懂的步骤标签；登录门与导航后检查指向会话稳定地标（先 `urlChange` URL 模式、再导航/表格容器等结构性元素）而非易变录制数据（单号、日期、列表行）；慢过渡后检查要求 `timeout` 指引、可为首步标注 settle；登录段保持门条件 + 容忍式登录组（可选凭据步骤收尾断言）以适配已登录/过期/记忆式 SSO；录制值参数（`input_N`/`select_N`/`password`/`file_N`）保留为模板且机器键不可改名，同时模型 SHALL 依页面证据为每个模板变量输出业务 label（语言随源材料、动词短语优先、成对区间加 -开始/-结束 后缀），并输出 variableActivities 建议表（按业务阶段与参数的使用关系，把每个模板变量关联到其所属 L1 分组的 id；仅作默认值，使用证据优先），未用变量不再滞留 Reference 页。

#### Scenario: 未知变量失败
- **WHEN** 模型引用了不存在的变量名
- **THEN** 生成失败，不产出半成品 Flow

#### Scenario: 变量业务命名
- **WHEN** 生成结果中存在证据充分的 `input_N` 变量
- **THEN** 每个模板变量都携带按证据给出的业务 label
