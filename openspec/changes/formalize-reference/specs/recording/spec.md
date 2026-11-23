# Spec Delta

## ADDED Requirements

### Requirement: Recorded parameters SHALL be extracted as Reference objects with business labels

录制端抽取的参数对象（导航地址 `url_N`、文本输入 `input_N`、下拉取值 `select_N`、上传占位 `file_N`、密码 `password`）SHALL 在保持机器键与模板语义不变的同时，逐个携带业务 label：优先取元素关联 label 文本，其次 placeholder、aria-label、name 属性；无文本证据时按输入类型给语义化名称（日期、数字、文本输入等）；同屏成对的日期输入（如开始/结束区间）在共同基础名后缀「-开始」「-结束」；同名冲突追加序号。任何兜底命名都使用业务化措辞，不得把机器键风格名（`input_1` 等）暴露为显示名。

#### Scenario: 成对日期命名
- **WHEN** 录制中用户在同一页面先后填写「创建日期」区间的开始与结束两个日期框
- **THEN** 两个对象的 label 分别为「创建日期-开始」与「创建日期-结束」

#### Scenario: 语义化兜底
- **WHEN** 某文本输入框没有任何 label/placeholder/aria 证据
- **THEN** 该对象获得按输入类型合成的中文业务名（含去重序号），而非机器键风格名
