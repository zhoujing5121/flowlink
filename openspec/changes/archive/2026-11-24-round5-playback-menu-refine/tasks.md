# Tasks

## 1. rrweb 回放黑屏：诊断 + 按报告修复（renderer-ui）

- [x] 1.1 Record 页新增「回放诊断」按钮与报告视图：检查 vendor 样式表加载与 `.replayer-*` 规则命中、iframe 尺寸/位置/computed 定位、事件总数与段数、Replayer 元数据、stage/tab-view 布局值；纯文本展示 + 一键复制；播放器未挂载/失败时不抛异常（见 design 决策 1 清单）
- [x] 1.2 真机：对黑屏录制点诊断，把报告发回（用户配合项，阻塞 1.3）
- [x] 1.3 依据报告实施修复（design 预置三径：CSS 未命中→运行时内联注入完整 rrweb 样式；iframe 零尺寸/错位→显式尺寸与定位兜底；数据段缺失→loadRrweb 链路检查）
- [ ] 1.4 真机复验：黑屏录制回放画面可见（含多段导航）；诊断按钮保留可用

## 2. Process 右键菜单（renderer-ui）

- [x] 2.1 菜单定位改为 `position: fixed` + 视口坐标（含边界夹取），步骤菜单同步迁移，验证缩放/平移下定位正确
- [x] 2.2 新增组右键菜单：右键组卡（标题/空白）弹出，菜单项=重命名/上移/下移/并入下一组/删除/重录该组/在其前/后插入，复用现有组操作函数与确认流程；右键步骤行仍弹步骤菜单；空白右键不弹；点击外/Esc 关闭
- [ ] 2.3 真机验证：缩放 60%+平移后右键组卡与步骤行，菜单位置正确且功能等效于组操作按钮

## 3. Refine 登录网关恢复（ai-integration）

- [x] 3.1 `config/prompts.json`：refine 与 autoSanitize 模板的登录段改为无条件主动重构指引（入口导航→网关 condition（trueStepId=凭据段后首个业务步骤、缺省=顺序继续）→isOptional 凭据→目标页断言 timeout 15000，并入首个业务阶段组）；systemPrompt 契约段一致；删除「If the instruction touches the login segment…」条件句
- [ ] 3.2 真机验证：对含 SSO 登录的原始录制执行默认 Refine（不含登录措辞的指令），结果包含网关 condition 与容忍式凭据步骤、登录不单独成组
- [ ] 3.3 真机验证：已登录会话 Test 该 REFINED 流程直达业务组（与 1.x/2.x 验证合并进行；若 Test 验证整体暂缓则顺延，不阻塞归档外任务）

## 4. 停录零自动 AI（renderer-ui）

- [x] 4.1 删除 bridge.js 停录路径两处 `recording-complete` 自动 advice 调用；排查并移除停录/分组重录结束路径上的 AI 面板自动打开逻辑；用户手动入口（预设项、Refine 按钮）不受影响
- [ ] 4.2 真机验证：录制结束进入分析页，AI 面板不自动打开、无自动 AI 消息；手动打开面板后功能正常

## 5. 收尾

- [x] 5.1 更新 CHANGELOG.md（docs/changelog-guide.md 格式）
- [x] 5.2 `npm run build` + `npx tsc --noEmit` 全绿
