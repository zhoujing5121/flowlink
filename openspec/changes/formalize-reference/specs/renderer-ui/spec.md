# Spec Delta

## ADDED Requirements

### Requirement: The Reference tab SHALL present typed objects with business-language columns

Reference 页 SHALL 以表格管理对象：勾选列 + Object（label 业务名）+ 类型（终端显示映射，不出现 "Variable" 包装）+ 值 + 必填 + 校验（中文业务短句摘要，如「必填 · 自动转大写 · 自动计算：今天+7 天」，不出现枚举值与表达式语法）+ 活动关联（多选 L1 分组，原始录制显示整段）+ 行操作。回放闸门拒绝时的违规文案同用业务短句；机器键不在任何用户可见处出现；文件上传支持 .xlsx/.xls/.csv/.md/.docx 并走工件持久化链路，保存经校验后的变量契约落盘并版本递增。

#### Scenario: 新列呈现
- **WHEN** 打开一份含变量与上传文件的录制的 Reference 页
- **THEN** 表格呈现 Object/类型映射/值/必填/校验/活动列，变量行与文件行同表，类型列显示终端映射名

#### Scenario: 机器键不可见
- **WHEN** 用户查看或编辑任一对象
- **THEN** 界面只出现 label 业务名，机器键不显示

### Requirement: The object editor dialog SHALL be wide and preset-first with an advanced fold

编辑/新建对话框 SHALL 宽度充足（约 720px、限高滚动、窄窗口不挤压）并按「基本 / 填写规则 / 活动关联 / 高级」分区。默认视图只呈现业务预设控件：label 去重、类型映射、必填开关、大小写/格式/正负选择、日期自动计算预设（今天 / 今天±N 天）、句子式条件必填（「当『某对象』已填写时本项必填」）；自定义正则与原始条件/公式表达式归入默认折叠的高级区，展开后保留即时语法校验与保存阻断；无法映射回预设的结构显示「自定义规则」。

#### Scenario: 预设优先编辑
- **WHEN** 业务用户打开编辑对话框且未展开高级区
- **THEN** 只看到中文业务预设控件，无正则与表达式语法；展开高级区才出现原始表达式编辑

#### Scenario: 编辑即时校验
- **WHEN** 用户在高级区输入一条语法非法的公式并触发校验
- **THEN** 对话框内即时报错并阻止保存，错误定位到表达式

### Requirement: The Add action SHALL open the editor directly and file-typed values SHALL use an upload control

Reference 页的 Add 按钮 SHALL 直接打开对象编辑对话框，不经过任何中间选择弹窗。编辑对话框中类型为 Excel/Word/CSV/Markdown/文件 的对象，值栏呈现为上传控件：无附件时点击即选择文件上传；有附件时控件显示文件名、点击可覆盖上传、右侧提供删除按钮；保存后表格值列显示该文件名。非文件类类型保持文本值输入，密钥保持掩码输入。

#### Scenario: Add 直开编辑框
- **WHEN** 用户点击 Reference 页的 Add 按钮
- **THEN** 直接出现对象编辑对话框，没有中间的选择弹窗

#### Scenario: 文件类值栏上传
- **WHEN** 用户把类型选为 CSV 并在值栏上传一个文件后保存
- **THEN** 表格值列显示该文件名，再次打开编辑器时值栏控件显示同一文件名且可覆盖或删除
