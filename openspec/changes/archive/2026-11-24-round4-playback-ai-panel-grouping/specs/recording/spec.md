# Spec Delta

## ADDED Requirements

### Requirement: Recording sessions SHALL capture full-page step screenshots non-disruptively

录制会话 SHALL 为每个动作步骤采集一张整页截图，采集机制 SHALL 不干扰页面呈现与用户输入（CDP screencast 单帧，与元素裁剪同机制）；截图写入录制产物的 `record/screenshots/` 目录并按步骤序号命名，停止时随录制元数据（`stepScreenshots`）暴露。环境开关 SHALL 能整体跳过步骤截图采集（诊断用途，跳过时截图缺省且录制流程不受影响）。

#### Scenario: 步骤截图产出
- **WHEN** 一次录制包含 5 个动作步骤并正常停止
- **THEN** 产物目录含 5 张按步骤序号命名的整页截图，且录制元数据 stepScreenshots 指向它们

#### Scenario: 采集不干扰操作
- **WHEN** 录制期间用户连续点击与输入
- **THEN** 页面无截图引起的闪烁，用户操作全部生效

#### Scenario: 诊断开关跳过采集
- **WHEN** 以步骤截图禁用开关启动录制
- **THEN** 录制正常完成，产物无步骤截图且 UI 呈现相应空态
