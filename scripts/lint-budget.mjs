/**
 * JSDoc 覆盖率棘轮（设计 D12/D13）：运行 ESLint，统计生产代码上的 jsdoc 规则
 * 警告数，与 lint-budget.json 的预算比较。预算只允许随注释回填下调，超出即失败；
 * 全部回填完成后预算归零、jsdoc 规则转 error，本脚本随之移除。
 *
 * 非 jsdoc 的问题（错误与非 jsdoc 规则的警告）一律导致退出码非零。
 * 退出码含义：0 = 通过；1 = 超预算或存在其他问题；2 = ESLint 运行本身失败。
 */
import { ESLint } from "eslint";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const budgetFile = path.join(root, "lint-budget.json");

const budget = JSON.parse(readFileSync(budgetFile, "utf8"));
if (typeof budget.jsdoc !== "number" || budget.jsdoc < 0) {
  console.error(`lint-budget.json 缺少非负的 "jsdoc" 数值字段`);
  process.exit(2);
}

const eslint = new ESLint({ cwd: root });
let results;
try {
  results = await eslint.lintFiles(["."]);
} catch (err) {
  console.error("ESLint 运行失败：", err.message);
  process.exit(2);
}

const jsdocWarnings = {};
const otherProblems = [];
let jsdocCount = 0;
let fileCount = 0;
for (const r of results) {
  if (!r.messages.length) continue;
  fileCount++;
  const rel = path.relative(root, r.filePath).replaceAll("\\", "/");
  for (const m of r.messages) {
    if (m.severity === 2) {
      otherProblems.push(`${rel}:${m.line}:${m.column}  error  ${m.message} (${m.ruleId ?? "fatal"})`);
    } else if (m.ruleId?.startsWith("jsdoc/")) {
      jsdocCount++;
      jsdocWarnings[m.ruleId] = (jsdocWarnings[m.ruleId] ?? 0) + 1;
    } else {
      otherProblems.push(`${rel}:${m.line}:${m.column}  warning  ${m.message} (${m.ruleId})`);
    }
  }
}

console.log(`ESLint 扫描完成：${results.length} 个文件，${fileCount} 个含问题`);

if (otherProblems.length) {
  console.log(`\n非 jsdoc 问题（${otherProblems.length}）：`);
  for (const line of otherProblems.slice(0, 50)) console.log("  " + line);
  if (otherProblems.length > 50) console.log(`  … 其余 ${otherProblems.length - 50} 条省略`);
}

console.log(`\njsdoc 违例：${jsdocCount}（预算 ${budget.jsdoc}）`);
for (const [rule, count] of Object.entries(jsdocWarnings).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule}: ${count}`);
}

let failed = false;
if (jsdocCount > budget.jsdoc) {
  console.error(`\n✗ jsdoc 违例 ${jsdocCount} 超出预算 ${budget.jsdoc}。注释只能增加不能减少；若是有意新增的缺注释代码，请先补注释再下调预算。`);
  failed = true;
} else if (jsdocCount < budget.jsdoc) {
  console.warn(`\n⚠ jsdoc 违例 ${jsdocCount} 已低于预算 ${budget.jsdoc}，请把 lint-budget.json 的 "jsdoc" 下调到 ${jsdocCount}。`);
}

if (otherProblems.length) failed = true;
process.exit(failed ? 1 : 0);
