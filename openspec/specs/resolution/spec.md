# Resolution Specification

## Purpose

回放与编辑期的元素定位契约：候选排序、指纹校验、frame 感知匹配与 URL 重定基。录制与回放两侧共享同一可见性语义；resolver 拥有评分与歧义处理。

## Requirements

### Requirement: Resolution SHALL follow recorded candidate order with one shared visibility semantic

Resolution SHALL follow the recorded candidate order under one shared visibility semantic on both the record and replay sides.

L1 语义候选与 L2 指纹池先丢弃不可见副本（模板/堆叠通知的退化矩形不再造成歧义性拒绝）；「多个匹配但恰有一个可见」解析到该可见元素；多个可见匹配仍须满足几何间距阈值，否则以歧义拒绝。

#### Scenario: 唯一可见匹配
- **WHEN** 候选匹配多个节点但仅一个可见
- **THEN** 解析到该可见元素

#### Scenario: 多可见匹配拒绝
- **WHEN** 候选匹配多个彼此邻近的可见节点
- **THEN** 解析以歧义失败并保留诊断证据

### Requirement: L2 attribute equality SHALL compare the fingerprint's recorded keys against raw attribute values

L2 attribute equality SHALL compare the fingerprint's recorded keys against the element's raw attribute values.

旧版宽松属性策略下录制的指纹仍能匹配。

#### Scenario: 旧指纹兼容
- **WHEN** 回放一个在旧属性策略下录制的 Flow
- **THEN** 指纹按其记录的键与当前原始属性值比对，保持可匹配

### Requirement: The resolver SHALL validate matches against context, frames, and fingerprints

The resolver SHALL validate matches against role/text/locator context, frame paths, and element fingerprints.

执行器动作代码不得绕过 resolver 自造 ad-hoc 定位器。匹配失败时错误/结果路径保留诊断证据，不报告成功的兜底。

#### Scenario: 无兜底
- **WHEN** 全部候选匹配失败
- **THEN** 步骤以带诊断信息的失败结束，不静默采用备选定位

### Requirement: URL re-basing SHALL replace the baseUrl origin for navigation and iframe matching

URL re-basing SHALL replace the `baseUrl` origin for navigate steps and iframe `urlPattern` matching.

共享实现位于 `engine/resolver/src/url.ts`。

#### Scenario: 换域名回放
- **WHEN** Reference 变量把起始 URL 换到新域名
- **THEN** 导航步骤与 iframe urlPattern 匹配按重定基后的 origin 工作

### Requirement: Resolution updates SHALL never mutate observed evidence

Resolution updates from self-healing or AI repair SHALL never mutate observed record-time evidence.

只允许更新 candidates/fingerprint 等 resolution 数据。

#### Scenario: AI 重锚定
- **WHEN** 修复流程为某元素前置 `source: "ai"` 候选
- **THEN** 仅候选链变化，observed 证据原样
