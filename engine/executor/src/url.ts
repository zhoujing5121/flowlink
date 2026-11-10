/**
 * URL 重定基 —— 实现已上移到 `@rr/resolver`（iframe 的 urlPattern 也要用同一套逻辑）。
 * 这里保留 re-export，保证 executor 自己的公开 API 不变；调用方应使用同一份重定基规则，
 * 以便顶层 navigate 与 iframe frame-path 匹配不会因各自实现而产生不同结果。
 */
export { describeRebase, matchesUrlPattern, NAME_KEEPALIVE_SOURCE, rebaseUrl } from '../../resolver/src/index.js'
