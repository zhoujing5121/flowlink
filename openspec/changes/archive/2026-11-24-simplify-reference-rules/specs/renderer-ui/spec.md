# Spec Delta

## MODIFIED Requirements

### Requirement: The Reference tab SHALL present typed objects with business-language columns

Reference 页 SHALL 以表格管理对象，列序为：勾选列 + Object（label 业务名）+ 类型（终端显示映射，不出现 "Variable" 包装）+ Locator（来源定位描述）+ Mandatory（必填标记）+ Validation（规则文本列，列名保持 Validation，展示用户输入或 AI 生成的规则文本，单行截断、悬停提示全文）+ 活动关联（多选 L1 分组，原始录制显示整段）+ 值 + 行操作。表格区域 SHALL 支持横向滚动并采用加大的列宽；回放闸门拒绝时的违规文案为必填缺失清单；机器键不在任何用户可见处出现；文件上传支持 .xlsx/.xls/.csv/.md/.docx 并走工件持久化链路，保存经校验后的变量契约落盘并版本递增。

#### Scenario: 新列呈现
- **WHEN** 打开一份含变量与上传文件的录制的 Reference 页
- **THEN** 表格按 Object/类型/Locator/Mandatory/Validation/活动/值 列序呈现，Validation 列显示规则文本，宽列随横向滚动可达

#### Scenario: 机器键不可见
- **WHEN** 用户查看或编辑任一对象
- **THEN** 界面只出现 label 业务名，机器键不显示

## REMOVED Requirements

### Requirement: The object editor dialog SHALL be wide and preset-first with an advanced fold
**Reason**: 校验统一改为自由文本规则，预设控件与高级表达式区不再存在（用户 2026-11-24 决策）。
**Migration**: 旧结构化校验数据经 schema v4 迁移转为规则文本；对话框不再有预设/高级概念。

## ADDED Requirements

### Requirement: Activity entries in the Reference table SHALL link to their Process group

活动列中每个已选活动 SHALL 独立成行呈现（行间有间隔）；点击某个活动 SHALL 跳转到 Process 页并高亮该活动对应的 L1 分组（复用分组选中视觉，点击别处或返回 Reference 后取消）。未 Refine 录制的整段隐含活动 SHALL 不可点击。

#### Scenario: 点击跳转高亮
- **WHEN** 用户在 Reference 页活动列点击某对象关联的「提交订单」活动
- **THEN** 视图切到 Process 页，「提交订单」分组以选中态高亮

#### Scenario: 整段活动不可点击
- **WHEN** 查看未 Refine 录制（活动列为整段录制）并点击该活动
- **THEN** 不发生跳转

### Requirement: The object editor dialog SHALL present basic fields, one rules text box, and activities

编辑/新建对话框 SHALL 保持宽布局（约 720px、限高滚动），分区为「基本（label 去重、类型映射、Locator、值、Mandatory 开关）/ 规则 / 活动关联」：规则区为单个多行自由文本输入框（自然语言占位示例，如「必须是邮箱格式；提交日期自动填今天」），无预设控件、无高级折叠、无表达式即时校验；值栏对文件类类型保持上传控件、密钥保持掩码输入。

#### Scenario: 单文本框规则
- **WHEN** 业务用户打开编辑对话框
- **THEN** 规则区只有一个多行文本框，任意自然语言可保存，无校验拦截

#### Scenario: 旧规则还原
- **WHEN** 打开一个经 v4 迁移、原携带结构化校验的对象
- **THEN** 规则文本框显示迁移转换后的中文句子

### Requirement: Reference placeholder exports SHALL not be generated

录制完成与 Refine 生成 workflow 时 SHALL 不再自动产出步骤导出占位文件（.xls/.md）——Reference 页不再出现这两类自动文件行；Download 打包仅包含对象附件。既有会话级占位行为随生成代码移除而消失，无存量清理。

#### Scenario: 新录制无占位文件
- **WHEN** 完成一次录制并打开其 Reference 页
- **THEN** 文件行只有用户主动上传/附件，没有自动生成的 .xls/.md 行
