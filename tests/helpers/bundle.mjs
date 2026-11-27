/**
 * tests/helpers/bundle.mjs —— 全仓库唯一的 esbuild 打包辅助函数。
 *
 * 供需要在 Node 里加载 engine 源码（TS、含相互导入）的测试使用：
 * 把入口打包成临时 ESM 文件后动态 import。临时目录懒创建、全测试进程共享，
 * 测试结束时调用 cleanupBundleTemp() 释放。
 */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let bundleTempDir = null;

async function ensureBundleTempDir() {
	if (!bundleTempDir) {
		bundleTempDir = await mkdtemp(join(tmpdir(), "flowlink-bundle-"));
	}
	return bundleTempDir;
}

/**
 * 把仓库内 TS 入口打包为临时 ESM 模块并导入，返回模块命名空间。
 * @param {string} entry 仓库相对入口路径（如 `engine/reference/src/labels.ts`）
 * @param {string} [name] 输出文件名前缀，默认取入口文件名
 * @returns {Promise<Record<string, unknown>>}
 */
export async function bundle(entry, name) {
	const dir = await ensureBundleTempDir();
	const base = name ?? entry.split("/").pop().replace(/\.ts$/, "");
	const outfile = join(dir, `${base}.mjs`);
	await build({
		entryPoints: [join(process.cwd(), entry)],
		bundle: true,
		platform: "node",
		format: "esm",
		outfile,
	});
	return import(pathToFileURL(outfile).href);
}

/** 释放 bundle 临时目录；在测试的 after() 中调用。 */
export async function cleanupBundleTemp() {
	if (bundleTempDir) {
		await rm(bundleTempDir, { recursive: true, force: true });
		bundleTempDir = null;
	}
}
