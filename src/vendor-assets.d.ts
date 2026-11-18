/**
 * 侧依赖声明：构建入口中以 `import 'rrweb/dist/style.css'` 方式引用的
 * CSS 资产由 esbuild 处理（产出 dist/renderer-vendor.css），tsc 只需知道
 * 该类模块存在、无导出。
 */
declare module '*.css'
