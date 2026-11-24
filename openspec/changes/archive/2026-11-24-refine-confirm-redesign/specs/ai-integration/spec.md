# Spec Delta

## ADDED Requirements

### Requirement: Advice responses SHALL carry a machine-readable intent verdict

AI 面板的建议调用（advice prompt）SHALL 要求模型在回复中携带机器可读的意图判定标注（至少区分 `refine` 与 `advice` 两类），渲染层据此分流：判定为 `refine` 时按来源匹配规则发起生成，判定为 `advice` 时按建议呈现。标注解析失败时 SHALL 回退为纯文本建议呈现，不得因契约解析失败阻断或报错。本地关键字正则不再作为生成意图的判定依据。

#### Scenario: 意图判定为 refine
- **WHEN** 用户在聊天中发送希望改进工作流的消息且模型标注 intent 为 refine
- **THEN** 客户端随后按来源匹配优先级发起生成流程

#### Scenario: 标注缺失或非法
- **WHEN** 模型回复中不含可解析的意图标注
- **THEN** 回复按普通建议呈现，用户不看到错误

### Requirement: Transport-class model request failures SHALL retry once with an actionable message

主进程对模型调用 SHALL 识别传输类失败（连接被对端关闭、socket 中断、请求在收到响应前失败等非模型内容错误），并自动重试一次；重试仍失败时，错误文案 SHALL 指向网络代理空闲超时的排查方向（可操作），不得与"模型输出无效"类错误混淆呈现。

#### Scenario: 首次请求被代理掐断
- **WHEN** 生成请求首次因连接被对端关闭而失败
- **THEN** 系统自动重发一次同一请求

#### Scenario: 重试仍失败
- **WHEN** 重试后仍为传输类失败
- **THEN** 用户看到的错误信息包含代理空闲超时的排查指引
