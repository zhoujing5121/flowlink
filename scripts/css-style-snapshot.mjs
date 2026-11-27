/**
 * CSS 计算样式快照工具（openspec: refactor-module-decoupling-and-layout，设计 D13）。
 *
 * 经 CDP 附着正在运行的 FlowLink 渲染进程（端口读 userData/DevToolsActivePort，
 * 应用本身始终以 --remote-debugging-port=0 启动），按预设的界面状态清单驱动
 * 界面并导出全部元素的计算样式（排除动画与时间敏感属性）。供第 5 阶段 CSS
 * 走读/合并/拆分前后做"同一状态计算样式对等"验证；只在应用空闲时运行。
 *
 * 用法：
 *   node scripts/css-style-snapshot.mjs capture <输出目录>            全部自动状态（每个状态前刷新页面）
 *   node scripts/css-style-snapshot.mjs capture-current <目录> <名称>  把当前界面存为指定状态（manual 状态用：
 *                                                                      Test 运行态、Record 回放由真机先驱动到位）
 *   node scripts/css-style-snapshot.mjs compare <目录A> <目录B>        逐状态比对，报告差异
 *
 * 快照只写本地（默认 scratch-css-snapshot/，已 gitignore），不入库。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** 计算 CSS 自定义属性之外的常规属性清单；动画与时间敏感属性不入快照。 */
const EXCLUDED_PROPS = new Set([
	"animation-composition", "animation-delay", "animation-direction", "animation-duration",
	"animation-fill-mode", "animation-iteration-count", "animation-name", "animation-play-state",
	"animation-range-end", "animation-range-start", "animation-timeline", "animation-timing-function",
	"transition-behavior", "transition-delay", "transition-duration", "transition-property",
	"transition-timing-function", "caret-color", "d",
]);

/** 界面状态清单：name + prepare（页面刷新后按序 evaluate 的 JS）。manual 状态不经 capture 驱动。 */
const STATES = [
	{ name: "list" },
	{
		name: "profile-drawer",
		prepare: ["document.getElementById('create').click()"],
	},
	{
		name: "design-instruction",
		prepare: ["document.getElementById('create').click()", "document.getElementById('designTab').click()"],
	},
	{
		name: "design-process",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabProcess').click()",
		],
	},
	{
		name: "design-steps",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabSteps').click()",
		],
	},
	{
		name: "design-reference",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabReference').click()",
		],
	},
	{
		name: "design-metric",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabMetric').click()",
		],
	},
	{
		// 注意：切到 Test 页签时应用会自动展开 AI 面板（app.js 的既有行为），属确定性状态。
		name: "design-test",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabTest').click()",
		],
	},
	{
		name: "design-records",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('summaryTabRecords').click()",
		],
	},
	{
		name: "ai-open",
		prepare: [
			"document.getElementById('create').click()",
			"document.getElementById('designTab').click()",
			"document.getElementById('aiToggle').click()",
		],
	},
	{ name: "test-running", manual: true },
	{ name: "record-replay", manual: true },
];

/** 打开确认对话框但不等待其 Promise；捕获后由下一次 reload 复位。 */
const CONFIRM_DIALOG_STATE = {
	name: "confirm-dialog",
	prepare: ["void confirmWorkspaceAction('CSS 快照占位确认文本（不会被确认）')"],
};

/** 页内执行的样式提取：全部元素的计算样式 + 稳定路径。 */
const EXTRACT_SCRIPT = `(() => {
	const sample = getComputedStyle(document.body);
	const propNames = [];
	for (let i = 0; i < sample.length; i++) {
		const p = sample.item(i);
		if (!p.startsWith("--") && !${JSON.stringify([...EXCLUDED_PROPS])}.includes(p)) propNames.push(p);
	}
	const customNames = [...sample].filter(p => p.startsWith("--"));
	const all = [...propNames, ...customNames];
	function pathOf(el) {
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && node !== document.documentElement) {
			let tag = node.tagName.toLowerCase();
			if (node.id) { parts.unshift(tag + "#" + node.id); node = node.parentElement; continue; }
			const parent = node.parentElement;
			if (parent) {
				const sameTag = [...parent.children].filter(c => c.tagName === node.tagName);
				if (sameTag.length > 1) tag += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
			}
			parts.unshift(tag);
			node = parent;
		}
		return "html" + (parts.length ? ">" + parts.join(">") : "");
	}
	const els = [...document.querySelectorAll("*")];
	return els.map(el => {
		const cs = getComputedStyle(el);
		const styles = {};
		for (const p of all) {
			const v = cs.getPropertyValue(p);
			if (v) styles[p] = v;
		}
		return { p: pathOf(el), s: styles };
	});
})()`;

function resolveUserDataDir(args) {
	const flagIndex = args.indexOf("--user-data");
	if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
	const appData = process.env.APPDATA;
	if (!appData) throw new Error("无法定位 userData：请用 --user-data 指定 FlowLink 的 userData 目录");
	return join(appData, "flowlink");
}

async function readCdpPort(userDataDir) {
	const file = join(userDataDir, "DevToolsActivePort");
	if (!existsSync(file)) throw new Error(`未找到 ${file}：请先启动 FlowLink 应用`);
	const port = Number(readFileSync(file, "utf8").split("\n")[0]?.trim());
	if (!Number.isInteger(port) || port <= 0) throw new Error(`DevToolsActivePort 内容无效`);
	// 端口文件可能是上次运行的残留；先验证 CDP 端点存活。
	try {
		await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
	} catch {
		throw new Error(`端口 ${port} 无响应（DevToolsActivePort 是陈旧文件）：请启动 FlowLink 应用后重试`);
	}
	return port;
}

async function connectRenderer(port) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	// 渲染进程目标：加载 renderer/index.html 的 page。
	const target = list.find((t) => t.type === "page" && /renderer[\\/]index\.html/.test(t.url));
	if (!target) throw new Error("未找到 FlowLink 渲染页面目标：" + JSON.stringify(list.map((t) => ({ type: t.type, url: t.url }))));
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
	});
	let seq = 0;
	const pending = new Map();
	ws.addEventListener("message", (ev) => {
		const msg = JSON.parse(String(ev.data));
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		}
	});
	return {
		async call(method, params = {}) {
			const id = ++seq;
			ws.send(JSON.stringify({ id, method, params }));
			const msg = await new Promise((resolve) => pending.set(id, resolve));
			if (msg.error) throw new Error(`CDP ${method} 失败：${JSON.stringify(msg.error)}`);
			return msg.result;
		},
		close() {
			ws.close();
		},
	};
}

async function evaluate(cdp, expression, awaitPromise = false) {
	const r = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
	if (r.exceptionDetails) throw new Error("页面内执行失败：" + JSON.stringify(r.exceptionDetails).slice(0, 500));
	return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 刷新页面并等待应用完成启动（DOM 就绪 + 固定静置时间）。 */
async function reloadAndWait(cdp) {
	await evaluate(cdp, "location.reload()");
	await sleep(2500);
}

async function captureState(cdp, state, outDir) {
	console.log(`捕获状态 ${state.name} …`);
	if (!state.manual) {
		await reloadAndWait(cdp);
		for (const js of state.prepare ?? []) {
			const v = await evaluate(cdp, js);
			if (v === false) throw new Error(`状态 ${state.name} 的准备步骤返回 false：${js}`);
		}
	}
	await sleep(400);
	const elements = await evaluate(cdp, EXTRACT_SCRIPT);
	if (!Array.isArray(elements) || !elements.length) throw new Error(`状态 ${state.name} 未提取到任何元素`);
	mkdirSync(outDir, { recursive: true });
	const file = join(outDir, `${state.name}.json`);
	writeFileSync(file, JSON.stringify({ state: state.name, elementCount: elements.length, elements }, null, 1));
	console.log(`  ${elements.length} 个元素 → ${file}`);
}

async function cmdCapture(outDir, extraArgs) {
	const userDataDir = resolveUserDataDir(extraArgs);
	const port = await readCdpPort(userDataDir);
	const cdp = await connectRenderer(port);
	try {
		for (const state of [...STATES, CONFIRM_DIALOG_STATE].filter((s) => !s.manual)) {
			await captureState(cdp, state, outDir);
		}
	} finally {
		cdp.close();
	}
}

async function cmdCaptureCurrent(outDir, stateName, extraArgs) {
	if (!stateName) throw new Error("capture-current 需要 <状态名>");
	const userDataDir = resolveUserDataDir(extraArgs);
	const port = await readCdpPort(userDataDir);
	const cdp = await connectRenderer(port);
	try {
		await captureState(cdp, { name: stateName, manual: true }, outDir);
	} finally {
		cdp.close();
	}
}

async function cmdCompare(dirA, dirB) {
	if (!dirA || !dirB) throw new Error("compare 需要 <目录A> <目录B>");
	const names = readdirSync(dirA).filter((f) => f.endsWith(".json"));
	let diffCount = 0;
	for (const name of names) {
		const a = JSON.parse(readFileSync(join(dirA, name), "utf8"));
		const bFile = join(dirB, name);
		if (!existsSync(bFile)) {
			console.log(`${name}: B 侧缺失`);
			diffCount++;
			continue;
		}
		const b = JSON.parse(readFileSync(bFile, "utf8"));
		const diffs = [];
		const aMap = new Map(a.elements.map((e) => [e.p, e.s]));
		const bMap = new Map(b.elements.map((e) => [e.p, e.s]));
		if (a.elements.length !== b.elements.length) {
			diffs.push(`元素数不同：A=${a.elements.length} B=${b.elements.length}`);
		}
		for (const [path, styles] of aMap) {
			const other = bMap.get(path);
			if (!other) {
				diffs.push(`仅 A 有元素：${path}`);
				continue;
			}
			const keys = new Set([...Object.keys(styles), ...Object.keys(other)]);
			for (const k of keys) {
				if (styles[k] !== other[k]) diffs.push(`${path} 的 ${k}：${styles[k]} → ${other[k]}`);
			}
		}
		for (const path of bMap.keys()) {
			if (!aMap.has(path)) diffs.push(`仅 B 有元素：${path}`);
		}
		if (diffs.length) {
			diffCount++;
			console.log(`\n${name}: ${diffs.length} 处差异`);
			for (const d of diffs.slice(0, 40)) console.log("  " + d);
			if (diffs.length > 40) console.log(`  … 其余 ${diffs.length - 40} 处省略`);
		} else {
			console.log(`${name}: 一致`);
		}
	}
	console.log(`\n比对完成：${names.length} 个状态，${diffCount} 个有差异`);
	if (diffCount) process.exit(1);
}

const [command, arg1, arg2, ...rest] = process.argv.slice(2);
try {
	if (command === "capture") await cmdCapture(arg1, rest);
	else if (command === "capture-current") await cmdCaptureCurrent(arg1, arg2, rest);
	else if (command === "compare") await cmdCompare(arg1, arg2);
	else {
		console.log("用法见文件头注释。命令：capture | capture-current | compare");
		process.exit(2);
	}
} catch (err) {
	console.error("失败：", err.message);
	process.exit(1);
}
