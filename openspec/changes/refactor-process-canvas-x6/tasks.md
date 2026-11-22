# Tasks

## 1. 依赖接入与 spike

- [ ] 1.1 `package.json` 新增 `@antv/x6`（锁定 3.x 具体版本），`src/renderer-vendor.ts` 导出 `window.__flowlinkX6`，样式随 `dist/renderer-vendor.css` 产出，index.html 加载顺序保持 vendor 先于 app.js。验证：npm run build 产物包含 X6 与其样式，加载顺序正确，vendor 体积记录到 CHANGELOG。
- [ ] 1.2 Electron 45 真机 spike：验证嵌套容器节点、折叠/展开父节点、HTML 节点事件（点击/右键冒泡）、边 vertices+标签、vendor CSS 完整渲染五项。验证：应用内 spike 页全部通过；出现阻塞级问题即停下修订 proposal（回退 maxGraph），不继续后续任务。

## 2. 画布重建（渲染对等）

- [ ] 2.1 X6 画布搭建：注册分组卡/未分组伪组卡 HTML 节点（复用现有卡片 DOM/CSS）、Start/End 哨节点、菱形判定节点；消费 `layoutGraph` 坐标 setPosition；边按 dagre 折线 vertices 绘制并映射实线/是/否标签/虚线回跳样式；X6 自带 pan/zoom/fit 替换手写 world transform。验证：现有 Flow 打开后与现状布局一致（分段并行链、图例着色、菱形、回跳边逐项对等）；vendor 缺失时仍显式报错不白屏。
- [ ] 2.2 交互迁移：点击选中、步骤右键菜单、分组菜单（getBoundingClientRect 定位）、分支徽章与条件样式，经 X6 节点事件桥接回现有处理函数。验证：菜单动作（重录/加节点/插入/删除）与现状行为一致。
- [ ] 2.3 回放 overlay 与 Refine 对比视图迁移：节点/边状态 class 驱动现有样式（绿/红/灰描边、走过高亮、未走分支变暗），stepId 对齐逻辑不变；对比视图两画布实例复用渲染函数。验证：跑一次回放与一次 refine 对比，行为与现状一致。

## 3. 收尾验证

- [ ] 3.1 清理：删除 app.js 中被替换的自研渲染胶水（SVG 边层、world transform、pan/zoom、fit）；确认 `flow-graph.js` 三个导出未动。验证：代码中无残留死路径，npm run build + npx tsc --noEmit 通过（收尾验证任务）。
- [ ] 3.2 真机验证：打开纯录制、AI 合并多源（并行链+图例）、含条件分支（菱形+是/否边+回跳）三类 Flow，走查缩放/fit/菜单/回放 overlay/refine 对比。验证：用户确认对等无回归。
