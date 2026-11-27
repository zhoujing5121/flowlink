/**
 * engine 包间依赖边界测试（openspec: refactor-module-decoupling-and-layout，设计 D3）。
 *
 * 规则：engine 不得导入 electron/ 或 renderer/；包间只允许
 *   schema → reference、resolver → schema、recorder → schema 与 reference、
 *   executor → schema 与 resolver、reference → 无。
 * 实现方式：静态扫描 engine 下全部 .ts 文件的 import/export-from 说明符，
 * 相对说明符解析回 engine 内的包名，越界或未授权的包间边即失败。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

/** D3 允许的包间依赖边（键 → 允许导入的 engine 包集合）。 */
const ALLOWED_PACKAGE_DEPS = {
	schema: new Set(["reference"]),
	resolver: new Set(["schema"]),
	recorder: new Set(["schema", "reference"]),
	executor: new Set(["schema", "resolver"]),
	reference: new Set(),
};

function listTsFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, name.name);
		if (name.isDirectory()) out.push(...listTsFiles(full));
		else if (name.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** 引用说明符所属的 engine 包名；不在 engine 内返回 null，相对解析失败抛错。 */
function specifierTargetPackage(file, specifier) {
	if (!specifier.startsWith(".")) return null;
	const resolved = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
	const rel = relative(resolve("engine"), resolved);
	if (rel.startsWith("..") || resolve("engine") === resolved) return null;
	const [pkg] = rel.split(sep);
	return pkg;
}

describe("engine 依赖边界", () => {
	const files = listTsFiles("engine");

	test("扫描到了 engine 源码", () => {
		assert.ok(files.length > 40, `engine/**/*.ts 应有大量文件，实际 ${files.length}`);
	});

	test("engine 不导入 electron/ 或 renderer/", () => {
		const violations = [];
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/(?:from\s+|import\s+\(?\s*)["']([^"']+)["']/g)) {
				if (!m[1].startsWith(".")) continue;
				const resolved = resolve(dirname(file), m[1]).replace(/\.js$/, ".ts");
				const rel = relative(process.cwd(), resolved);
				if (rel.startsWith("electron") || rel.startsWith("renderer") || rel.startsWith("src")) {
					violations.push(`${file} → ${m[1]}`);
				}
			}
		}
		assert.deepEqual(violations, [], "engine 存在对 electron/renderer 的导入：\n" + violations.join("\n"));
	});

	test("包间依赖只走 D3 允许的边", () => {
		const violations = [];
		for (const file of files) {
			const fromPkg = relative(resolve("engine"), file).split(sep)[0];
			if (!ALLOWED_PACKAGE_DEPS[fromPkg]) continue; // 未知包：允许（新增包时在此登记规则）
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/(?:from\s+|import\s+\(?\s*)["']([^"']+)["']/g)) {
				const toPkg = specifierTargetPackage(file, m[1]);
				if (!toPkg || toPkg === fromPkg) continue;
				if (!ALLOWED_PACKAGE_DEPS[fromPkg].has(toPkg)) {
					violations.push(`${fromPkg} → ${toPkg}（${file} → ${m[1]}）`);
				}
			}
		}
		assert.deepEqual(violations, [], "engine 存在未授权的包间依赖：\n" + violations.join("\n"));
	});
});
