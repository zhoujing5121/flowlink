# Spec Delta

## MODIFIED Requirements

### Requirement: Generation SHALL project element references into a deduplicated library within hard budgets

Generation SHALL project every element reference into a deduplicated `$ref` library and fail loudly when hard budgets are exceeded.

管线（`electron/ai/ai-refine.ts`，IPC `pi:generateFlow`）完全在主进程运行，渲染层只发送录制 id、可选指令与纯文本会话。投影阶段把源步骤中所有 `target`/`from`/`to`/`expect.target` 替换为 `{"$ref":"eN"}`（键为 `fingerprint.stableHash` + 首候选），提示中每个库元素只出现一次；预算上限——库 10k、步骤 60k、会话 12k、指令 4k 字符——超限响亮失败而非截断。提示用 auto-sanitize 或 refine-with-instruction 两套固定模板，worker 系统提示额外禁止内联元素数据与 `flow.variables` 输出。

#### Scenario: 预算超限
- **WHEN** 源材料超出任一预算上限
- **THEN** 生成失败并报错，不截断提示继续
