/**
 * IPC 契约快照测试（openspec: refactor-module-decoupling-and-layout，设计 D13）。
 *
 * 守住的契约：preload 暴露的 invoke 通道（50）、事件白名单（14）与 API 分组形状
 * 在主进程拆分前后完全不变——渲染层与主进程以这些字面量为唯一协议。
 *
 * 提取方式：静态解析 preload.ts 源文本（分组块 → 方法名与 invoke 通道、
 * on() 内的 valid 白名单）。第 3.1 阶段通道常量落地后，本测试改为从
 * electron/ipc/channels.ts 取清单，与同一份快照比对。有意的契约变更必须
 * 更新快照并同步 preload 与主进程两侧。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";

const PRELOAD_PATH = "electron/preload.ts";
const SNAPSHOT_PATH = "tests/architecture/snapshots/ipc-channels.json";

/** 从 preload.ts 源文本提取 { invokeChannels, apiShape, events }。 */
function extractIpcContract(source) {
	const lines = source.split(/\r?\n/);
	const invokeChannels = {};
	const apiShape = {};
	const events = [];
	let group = null;
	for (const line of lines) {
		const groupMatch = line.match(/^\t(\w+): \{$/);
		if (groupMatch) {
			group = groupMatch[1];
			invokeChannels[group] = [];
			apiShape[group] = [];
			continue;
		}
		if (!group) continue;
		const method = line.match(/^\t\t(\w+):/);
		if (method && !/^\t\t(const|return|if)\b/.test(line)) {
			apiShape[group].push(method[1]);
		}
		const channel = line.match(/ipcRenderer\.invoke\('([^']+)'/);
		if (channel) invokeChannels[group].push(channel[1]);
		const event = line.match(/^\t{3}'([a-zA-Z:]+)',?$/);
		if (event) events.push(event[1]);
	}
	return { invokeChannels, apiShape, events };
}

describe("IPC 契约快照", () => {
	test("invoke 通道、事件白名单与 API 分组形状与快照一致", () => {
		const actual = extractIpcContract(readFileSync(PRELOAD_PATH, "utf8"));
		let snapshot;
		try {
			snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		} catch {
			writeFileSync(SNAPSHOT_PATH + ".actual", JSON.stringify(actual, null, 2) + "\n");
			assert.fail(`快照缺失或不可读；已生成 ${SNAPSHOT_PATH}.actual，确认后复制为正式快照`);
		}
		let mismatch = "";
		for (const key of ["invokeChannels", "apiShape", "events"]) {
			if (JSON.stringify(snapshot[key]) !== JSON.stringify(actual[key])) {
				mismatch += `${key} 变化：\n  快照: ${JSON.stringify(snapshot[key])}\n  实际: ${JSON.stringify(actual[key])}\n`;
			}
		}
		if (mismatch) {
			writeFileSync(
				SNAPSHOT_PATH + ".actual",
				JSON.stringify(actual, null, 2) + "\n",
			);
			assert.fail(`IPC 契约变化（还原改动，或确认后用 .actual 更新快照并同步主进程两侧）：\n${mismatch}`);
		}
	});

	test("契约规模不变：50 个 invoke、14 个事件", () => {
		const actual = extractIpcContract(readFileSync(PRELOAD_PATH, "utf8"));
		const invokeTotal = Object.values(actual.invokeChannels).flat().length;
		assert.equal(invokeTotal, 50, `invoke 通道数应为 50，实际 ${invokeTotal}`);
		assert.equal(actual.events.length, 14, `事件白名单应为 14，实际 ${actual.events.length}`);
	});
});
