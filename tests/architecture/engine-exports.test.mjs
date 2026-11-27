/**
 * engine 各包 index.ts 导出清单快照测试（openspec: refactor-module-decoupling-and-layout，
 * 设计 D3/D13）。守住的契约：五个包 index.ts 的导出语句清单与运行时值导出名
 * 在结构重构前后都不变——schema.ts 拆分、record.ts/run.ts 抽出外围文件等改动
 * 不得改变任何包的公共入口面。
 *
 * 运行时值导出通过 tsx 直接动态导入 index.ts 采集（types 不可运行时观察）；
 * 导出语句清单从 index.ts 源文本提取（同时覆盖 type-only 导出）。
 * 与 snapshots/engine-exports.json 比对；有意的公共面变更必须显式更新快照并在
 * 提交说明中说明理由。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "node:test";

const PACKAGES = ["schema", "reference", "resolver", "recorder", "executor"];
const SNAPSHOT_PATH = "tests/architecture/snapshots/engine-exports.json";

function exportStatements(indexSource) {
	// 逐行提取 index.ts 里的 export 语句（index.ts 是纯再导出文件，无实现体）。
	return indexSource
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("export "));
}

describe("engine 导出清单快照", () => {
	test("运行时值导出名与快照一致", async () => {
		const actual = {};
		for (const pkg of PACKAGES) {
			const mod = await import(pathToFileURL(resolve(`engine/${pkg}/src/index.ts`)).href);
			actual[pkg] = Object.keys(mod).sort();
		}
		const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		let mismatch = "";
		for (const pkg of PACKAGES) {
			if (JSON.stringify(snapshot[pkg].values) !== JSON.stringify(actual[pkg])) {
				mismatch += `${pkg}: 运行时导出变化\n  快照: ${snapshot[pkg].values.join(", ")}\n  实际: ${actual[pkg].join(", ")}\n`;
			}
		}
		if (mismatch) {
			// 输出更新后的快照内容，供有意变更时复制。
			const updated = structuredClone(snapshot);
			for (const pkg of PACKAGES) updated[pkg].values = actual[pkg];
			writeFileSync(SNAPSHOT_PATH + ".actual", JSON.stringify(updated, null, 2) + "\n");
			assert.fail(`engine 公共导出面变化（还原改动，或确认后用 .actual 文件更新快照）：\n${mismatch}`);
		}
	});

	test("index.ts 导出语句与快照一致", () => {
		const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		const mismatch = [];
		for (const pkg of PACKAGES) {
			const actual = exportStatements(readFileSync(`engine/${pkg}/src/index.ts`, "utf8"));
			if (JSON.stringify(snapshot[pkg].statements) !== JSON.stringify(actual)) {
				mismatch.push(`${pkg}: index.ts 导出语句变化\n  快照: ${JSON.stringify(snapshot[pkg].statements)}\n  实际: ${JSON.stringify(actual)}`);
			}
		}
		assert.deepEqual(mismatch, [], "index.ts 导出语句变化：\n" + mismatch.join("\n"));
	});
});
