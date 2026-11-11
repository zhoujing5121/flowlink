# FlowLink

FlowLink 是一个面向 Windows 的桌面自动化工具，用于录制浏览器操作流程、将其保存为结构化的动作轨迹，并通过 Playwright 回放。项目基于 Electron，录放能力由本地引擎提供，并通过 Chrome DevTools Protocol（CDP）附着到嵌入式 WebContentsView。

## 功能

- 在 Electron 应用中录制浏览器操作
- 创建任务档案，并为每个任务保存多条录制
- 回放包含步骤、断言、变量和等待的流程
- 录制标签页打开/切换和手动导航，并将录制的文本输入参数化到 Reference
- 将 HTML5 拖拽录制为可回放的 drag 步骤；SSO/登录跳转自动识别并录制为可选步骤，回放时若跳转已自行发生则自动跳过
- 在 Process 中编辑分组、手动等待和基于断言的条件分支（每次回放每组最多访问三次）
- 通过原生 Electron 视图打开回放标签页，并在每次进入 Test 时提供全新的单标签浏览器
- 采集元素证据、截图、对话框、下载、标签页及 iframe 上下文
- 通过候选定位器、指纹和多级解析定位元素
- 重新录制流程并查看执行产物
- 重录或插入流程节点前回放所需前缀步骤，并从回放后的浏览器状态继续录制
- 将任务和录制持久化到 Electron 用户数据目录
- 打包成 Windows x64 ZIP

## 环境要求

- Windows x64
- Node.js 20 或更高版本
- npm
- Electron 与 Playwright 依赖已通过 `package-lock.json` 安装

## 安装与运行

```powershell
npm install
npm run start
```

开发模式会打开 Electron DevTools：

```powershell
npm run dev
```

以上命令都会通过 `scripts/start.ps1` 在启动 Electron 前将控制台输入输出切换为 UTF-8，避免 Windows 终端中的中文诊断日志出现乱码。如果已经在 PowerShell 中工作，也可以直接调用启动脚本，让编码设置先于任何输出管道生效：

```powershell
& .\scripts\start.ps1
```

开发模式使用 `& .\scripts\start.ps1 -Dev`。该设置仅影响当前控制台会话，不会修改 PowerShell 配置文件或系统区域设置。

构建会生成：

- `dist/main.js` 和 `dist/main.js.map`
- `dist/preload.cjs` 和 `dist/preload.cjs.map`

录制器从 `engine/recorder/capture/capture.js` 加载采集脚本。

```powershell
npm run build
```

## 打包 Windows 应用

```powershell
npm run package
```

打包脚本会使用 `electron-packager`，并生成：

- `release\FlowLink-win32-x64\`
- `release\FlowLink-Windows-x64.zip`

打包脚本要求 Electron 包内包含 `ffmpeg.dll`；缺失时会停止打包归档。

## 快速使用

1. 创建或选择任务。
2. 输入 HTTP 或 HTTPS 起始网址。
3. 开始录制。
4. 在嵌入式浏览器中执行操作。
5. 停止录制，保存 flow 和 artifacts。如果没有捕获到步骤，停止时会要求确认，并直接退出而不生成录制。
6. 运行录制，在嵌入式浏览器中回放。原生标签页创建及其首次导航会合并为一个 `openTab` 动作回放。
7. 查看截图、步骤结果、下载内容和执行日志。

在 Process 中可以为已保存的流程添加分组和手动步骤。条件必须是分组的最后一步，并跳转到已有分组；用户操作等待会暂停回放，直到用户选择 Continue。录制的文本输入会作为变量显示在 Reference 中，密码值会作为 secret 处理。

删除录制时会一并删除对应的 Flow 和录制产物；删除任务时会删除其全部录制及文件；新建任务尚未保存就关闭时，会丢弃该草稿中生成的录制。

## 目录结构

```text
src/                    Electron 主进程与 Preload 桥接
renderer/               桌面界面与渲染进程 IPC 集成
engine/
  schema/               Flow JSON Schema、迁移、解析与校验
  recorder/             页面采集、事件合流、流程规划与登录态
  resolver/             元素候选与 frame 解析
  executor/             回放、自愈、产物、标签页、对话框与下载
capture/                构建时复制的页面采集脚本
release/                已有打包产物目录
dist/                   生成的构建产物
```

详细说明请阅读 [架构文档](docs/architecture.md)、[贡献指南](CONTRIBUTING.md) 和 [Agent 开发指令](AGENTS.md)。

## 持久化数据

Electron 用户数据目录中的状态位于：

```text
<userData>\flowlink\tasks.json
<userData>\flowlink\flows\*.json
<userData>\flowlink\artifacts\<flowId>\...
```

回放产物采用以下结构：

```text
artifacts\<flowId>\runs\<runId>\
  result.json
  <stepIndex>\before.png
  <stepIndex>\after.png
  <stepIndex>\snapshot.json
  <stepIndex>\log.txt
```

## 安全说明

- Preload 只向渲染进程暴露受控的 `window.flowlink` API。
- 地址栏和 IPC 导航仅接受 HTTP、HTTPS。
- 密码类型输入必须使用 `{{variable}}` 模板，禁止明文写入 flow。
- 登录态包含 Cookie 和 local storage 凭据，不得提交到仓库。
- 产物和下载文件名会经过路径清洗。
- 内嵌页面的新窗口请求会被重定向到当前浏览器视图。

## 当前状态

仓库尚未提供项目自带的自动化测试脚本或 lint 脚本。当前主要校验方式是 esbuild 构建、TypeScript 编译器严格配置以及 Zod Flow 校验。改动完成后运行 `npm run build` 和 `npx tsc --noEmit`；引入测试框架后再补充针对性测试。

## Pi AI 助手（可选）

FlowLink 按需加载 Pi SDK，不会在应用启动时初始化。Pi 的服务商和模型配置位于 `config/pi-settings.json`，开发环境凭据位于 `config/pi-auth.json`。对于兼容 OpenAI 的企业内部服务，将 provider 设置为 `custom`，把 `config/models.example.json` 复制为 `config/models.json`，并在其中填写服务地址和准确的模型 ID；凭据文件中的 provider 键也使用 `custom`。这样企业服务商 ID 和服务地址只保存在本地 `models.json`，不会出现在 Pi settings 中。`config/models.json` 和 API 密钥文件已从 Git 跟踪中排除。

启动时可以为 Pi 配置代理：打包版使用 `FlowLink.exe --pi-system-proxy` 解析 Windows 系统代理/PAC，或使用 `FlowLink.exe --pi-proxy=http://127.0.0.1:7890` 指定代理。开发环境可运行 `npm start -- -PiSystemProxy` 或 `npm start -- -PiProxy "http://127.0.0.1:7890"`。显式代理优先于系统代理；支持 `http`、`https` 和 `socks5`。也可继续使用 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY` 环境变量。以上设置只影响 Pi 请求，不会配置内嵌 Chromium 浏览器的网络代理。不要提交带认证信息的代理 URL。

AI 助手面板提供录制后建议、回放失败诊断，并支持用 `@` 提及当前任务的录制来发起请求。选中已分析的录制并点击 Refine，可选择预设优化项并补充说明后生成细化材料；录制停止后也会自动生成一份 `REFINED…` 孪生录制（在 `config/pi-settings.json` 中设置 `autoRefine: false` 可关闭）。所有细化结果都以新录制保存，原始录制保持不变。
