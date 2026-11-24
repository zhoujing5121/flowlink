# Spec Delta

## REMOVED Requirements

### Requirement: Replay SHALL gate on Reference validation and resolve values before startup
**Reason**: 结构化校验（格式/大小写/公式/条件必填的程序解析与执行）随产品方向移除——规则改由 AI 理解与执行，程序不再解析（用户 2026-11-24 决策）；「公式回放期求值」等行为随之消失。
**Migration**: 闸门保留必填缺失拦截与非必填空串注入（见 ADDED 的替代 requirement）；存量结构化规则经 schema v4 迁移转为规则文本，由后续 AI 执行能力接手。

## ADDED Requirements

### Requirement: Replay SHALL gate on Reference mandatory values before startup

回放启动前 SHALL 对全部 Reference 对象统一执行一次 Mandatory 检查，并一次性报告全部缺失（对象 label + 原因），存在必填缺失则不启动回放。规则文本（`rules`）不参与程序侧校验——不解析、不执行。注入语义：非必填且无值、无默认的对象以空串注入；文件类对象携带附件时注入工件内绝对路径；密钥对象沿用只进当次回放、不落盘的既有行为。

#### Scenario: 必填缺失阻止启动
- **WHEN** 用户在两个必填对象留空时点击回放
- **THEN** 启动被阻止，一次性列出两个对象的必填缺失，回放不开始

#### Scenario: 非必填空串继续
- **WHEN** 某非必填对象无值无默认
- **THEN** 回放正常启动，该对象以空串注入模板，不再因缺失失败

#### Scenario: 规则文本不拦截
- **WHEN** 某对象的规则文本写有「必须是邮箱格式」而值不是邮箱
- **THEN** 程序不解析该文本，回放照常启动（AI 执行属后续能力）
