/**
 * 仅注释提交校验（openspec: refactor-module-decoupling-and-layout，设计 D11/D12）。
 *
 * 用法：node scripts/assert-comment-only.mjs <基线提交|index> <路径…>
 *
 * 基线可以是 git 提交号，也可以是 `index`（当前暂存区，用于结构改动已暂存、
 * 尚未提交时的注释批次校验）。
 *
 * 把基线提交与工作区的每个文件分别经 esbuild 规范化（剥离全部注释与空白、
 * 压缩为等价最小形式，legalComments:'none' 保证不留任何注释）后逐字节比较。
 * 任何标识符、字符串、结构上的改动都会导致规范化产物不同，即校验失败。
 * 用于注释回填批次：只有"去注释后完全等价"的改动才允许以仅注释提交入库。
 *
 * 退出码：0 = 全部文件仅注释等价；1 = 存在代码差异或读取失败。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { transformSync } from "esbuild";
import process from "node:process";

const [baseline, ...paths] = process.argv.slice(2);
if (!baseline || !paths.length) {
	console.error("用法：node scripts/assert-comment-only.mjs <基线提交> <路径…>");
	process.exit(2);
}

function loaderOf(path) {
	if (path.endsWith(".ts")) return "ts";
	if (path.endsWith(".mjs") || path.endsWith(".cjs")) return "js";
	if (path.endsWith(".js")) return "js";
	throw new Error(`不支持的文件类型：${path}`);
}

/** esbuild 规范化：剥注释、剥空白、minify 为确定性的等价形式。 */
function normalize(source, loader) {
	return transformSync(source, { loader, minify: true, legalComments: "none" }).code;
}

function showFile(rev, path) {
	const spec = rev === "index" ? `:${path}` : `${rev}:${path}`;
	return execFileSync("git", ["show", spec], {
		maxBuffer: 64 * 1024 * 1024,
		encoding: "utf8",
	});
}

let failed = false;
for (const path of paths) {
	let baselineNorm;
	let currentNorm;
	try {
		const loader = loaderOf(path);
		baselineNorm = normalize(showFile(baseline, path), loader);
		currentNorm = normalize(readFileSync(path, "utf8"), loader);
	} catch (err) {
		console.error(`✗ ${path}：读取/解析失败 — ${err.message.split("\n")[0]}`);
		failed = true;
		continue;
	}
	if (baselineNorm === currentNorm) {
		console.log(`✓ ${path}：仅注释/空白等价`);
		continue;
	}
	// 找到第一个差异位置，给出可操作的定位提示。
	let at = 0;
	while (at < baselineNorm.length && at < currentNorm.length && baselineNorm[at] === currentNorm[at]) at++;
	const ctx = (s) => s.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, "\\n");
	console.error(`✗ ${path}：存在代码差异（规范化后位置 ${at}）`);
	console.error(`  基线: …${ctx(baselineNorm)}…`);
	console.error(`  当前: …${ctx(currentNorm)}…`);
	failed = true;
}

process.exit(failed ? 1 : 0);
