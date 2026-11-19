# Spec Delta

## MODIFIED Requirements

### Requirement: Condition steps SHALL route to existing groups under a three-visit loop limit

Condition steps SHALL route execution to any existing step or fall through sequentially, bounded by a three-visit loop limit per top-level group.

条件步骤可在组内任意位置出现（不限于组末）。求值为有界重试：在默认 4 秒窗口内每 300ms 重评一次（步骤 `timeout` 可覆盖并钳制到 [1000, 30000]），任一次匹配即判定为真；断言错误中 `EXPECT_MISMATCH` 视为 false，其余错误照常抛出。分支目标存在时把扁平游标跳到**目标步骤**（同 Flow 内任意已存在步骤，不再限于组开头）；分支缺省（未指定目标）时**顺序继续**（不跳转、执行组内下一步，两分支都缺省时仅记录判定结果后继续）；被跳过的步骤以 `skip` 结果上报；防环护栏沿用：每个顶层分组每次运行最多进入 3 次，第 4 次以 `FLOW_LOOP_LIMIT` 失败终止（即使 stopOnFailure 关闭）。

#### Scenario: 循环上限
- **WHEN** 分支组合使同一分组第 4 次进入
- **THEN** 运行以 FLOW_LOOP_LIMIT 失败终止

#### Scenario: 分支跳过上报
- **WHEN** 条件跳转到后置目标步骤
- **THEN** 被跳过区间的步骤在报告中为 skip 状态

#### Scenario: 缺省分支顺序继续
- **WHEN** 组内条件判定为 false 且 false 分支未指定目标
- **THEN** 执行继续该条件的下一步骤（如组内容忍式登录步骤），运行不终止

#### Scenario: 慢页面判定容忍
- **WHEN** 网关条件在导航后立刻求值而目标元素尚未渲染
- **THEN** 求值在窗口内重试，元素出现后判定为真，不因瞬时缺失误判为 false

#### Scenario: 任意步骤目标
- **WHEN** 条件步骤的目标指向另一组内的某个具体步骤（非该组开头）
- **THEN** 游标跳到该步骤继续执行，目标之前的该组步骤上报 skip
