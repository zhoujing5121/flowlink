# Spec Delta

## ADDED Requirements

### Requirement: Replay SHALL gate on Reference validation and resolve values before startup

回放启动前 SHALL 对全部 Reference 对象统一执行一次校验与求值，并一次性报告全部违规（对象 label + 规则 + 原因），存在任何违规则不启动回放。校验范围：必填缺失（含条件必填表达式为真时的缺失）、格式预设与自定义正则、正负规则、公式与条件表达式的求值错误。求值与注入语义：公式对象的值由表达式求值产生；大小写规则在注入前应用；非必填且无值、无默认、无公式的对象以空串注入（替代旧的缺失即失败语义）；密钥对象沿用只进当次回放、不落盘的既有行为。

#### Scenario: 必填缺失阻止启动
- **WHEN** 用户在两个必填对象留空时点击回放
- **THEN** 启动被阻止，一次性列出两个对象的必填违规，回放不开始

#### Scenario: 非必填空串继续
- **WHEN** 某非必填对象无值无默认无公式
- **THEN** 回放正常启动，该对象以空串注入模板，不再因缺失失败

#### Scenario: 公式回放期求值
- **WHEN** 某日期对象公式为 `DATEADD(TODAY(), 7, "day")`
- **THEN** 每次回放启动时重新求值，注入的值为当天加 7 天
