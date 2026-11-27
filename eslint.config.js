// ESLint 按设计 D12 接入：no-undef 守渲染层拆分，jsdoc 规则守注释规范。
// 注：项目 typescript 为 7.x 原生编译器（无 JS API），typescript-eslint 不可用，
// TS 文件改用 @babel/eslint-parser 做纯语法解析（D12 不要求 type-aware 规则）。
import globals from "globals";
import jsdocPlugin from "eslint-plugin-jsdoc";
import babelParser from "@babel/eslint-parser";

// JSDoc 存在性：覆盖 D11 列出的构造——具名函数、类方法、对象方法、
// 赋给具名常量的函数表达式/箭头函数。行内匿名回调不要求。
const jsdocExistence = {
  "jsdoc/require-jsdoc": [
    "warn",
    {
      contexts: [
        "FunctionDeclaration",
        "MethodDefinition",
        "Property[method=true]",
        "PropertyDefinition > ArrowFunctionExpression",
        "VariableDeclaration[kind='const'] > VariableDeclarator > ArrowFunctionExpression",
        "VariableDeclaration[kind='const'] > VariableDeclarator > FunctionExpression",
      ],
    },
  ],
};

// 渲染层 JS 额外强制类型标签（D12）。
const jsdocWithTypes = {
  ...jsdocExistence,
  "jsdoc/require-param": "warn",
  "jsdoc/require-param-type": "warn",
  "jsdoc/require-returns": "warn",
  "jsdoc/require-returns-type": "warn",
};

// 过渡期放行：经典脚本时代跨文件共享的全局名（bridge.js 覆盖 app.js 的顶层函数等）。
// 63 个名字均已在 renderer/*.js 之一中声明（app.js:32 的 $、app.js:5181–5184 的
// let 链、其余为 app.js/bridge.js/flow-graph.js 顶层声明），此处仅为 per-file
// no-undef 的过渡桥接。拆分完成后（4.12）此清单必须归零，由
// tests/architecture/renderer-structure.test.mjs 守住。
const legacyRendererGlobals = Object.fromEntries(
  [
    "$",
    "FlowGraph",
    "activeBrowserPage",
    "activeFlowKey",
    "addBrowserPage",
    "appendAIMessage",
    "beginGroupRecording",
    "bindAIDock",
    "captureBrowserAction",
    "closeBrowserPage",
    "closeDrawer",
    "confirmWorkspaceAction",
    "createBrowserPage",
    "createBrowserSurface",
    "currentFlow",
    "drawerView",
    "ensureProcessGroups",
    "ensureRecordingLayout",
    "finishBrowserRecording",
    "finishGroupRecording",
    "flowData",
    "flowRowActionDisabled",
    "generatedRecordingName",
    "hydrateProcessFlow",
    "loadRecordingFrame",
    "mountBrowserSurface",
    "moveRecordingHistory",
    "navigateRecordingBrowser",
    "nextTaskVersion",
    "nextTaskflowCode",
    "openDrawer",
    "openRecordingURL",
    "processGroupSequence",
    "processStepLabel",
    "profileDraft",
    "profileDrafts",
    "rebuildItemTestFlow",
    "recordingSequence",
    "recordingSession",
    "recordingSessions",
    "recordingTestURL",
    "reference",
    "render",
    "renderRecordingItems",
    "renderRecordingWorkspace",
    "renderSummaryWorkspace",
    "requestRecordingSnapshot",
    "resetRecordingForNewSession",
    "resetTestBrowser",
    "saveProfile",
    "setProcessLandscape",
    "setProcessLandscapeError",
    "showDrawerTab",
    "startBrowserRecording",
    "startRecordingMedia",
    "stopRecordingMedia",
    "switchBrowserPage",
    "syncBrowserSession",
    "syncFloatingAIDock",
    "updateBrowserChrome",
    "updateRecordingActionButton",
    "validateProfileServices",
    "validatedRecordingURL",
  ].map((name) => [name, "writable"]),
);

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "release/**",
      "ui_prototype/**",
      "docs/**",
      "openspec/**",
      "scratch-css-snapshot/**",
      "renderer/assets/**",
    ],
  },
  {
    files: ["tests/**/*.{js,mjs,cjs}", "scripts/**/*.mjs", "build.mjs", "package.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: ["engine/**/*.ts", "electron/**/*.ts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { parserOpts: { plugins: ["typescript"] } },
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: { jsdoc: jsdocPlugin },
    rules: { ...jsdocExistence },
  },
  {
    files: ["renderer/**/*.js"],
    ignores: ["renderer/assets/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        FlowLinkUI: "writable",
        ...legacyRendererGlobals,
      },
    },
    plugins: { jsdoc: jsdocPlugin },
    rules: {
      "no-undef": "error",
      ...jsdocWithTypes,
    },
  },
  {
    files: ["engine/recorder/capture/capture.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
    plugins: { jsdoc: jsdocPlugin },
    rules: {
      "no-undef": "error",
      ...jsdocExistence,
    },
  },
];
