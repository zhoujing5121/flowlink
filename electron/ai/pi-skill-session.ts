/**
 * Pi 生成模式会话组装：把内置 Skills 经 skillsOverride 注入 Pi 原生 Skills 机制，
 * 并提供唯一自定义受限 read 工具（命名锁定 read——Pi 系统提示构建器只在会话声明
 * 名为 read/bash 的工具时注入 Skills 提示段，改名会使 Skills 对模型完全不可见）。
 *
 * 安全边界（严格模式 A）：
 * - read 只允许读取 allowlist（内置 Skill 根目录下的 SKILL.md 与明确列入的纯文本参考文件，
 *   均为真实路径）；拒绝目录外路径、路径穿越、符号链接逃逸、外部绝对路径、目录、二进制与脚本。
 * - 单次与每请求累计读取受预算约束，超限显式拒绝，不静默截断。
 * - Skill 内容不能改变工具白名单；不注册 Bash/PowerShell/Write/Edit/Grep/Find/LS。
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
	createSyntheticSourceInfo,
	defineTool,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SKILL_READ_BUDGET_CHARS, type PiSkillConfig } from "./pi-config.js";
import { appLog, appLogFields } from "../infra/app-logger.js";

/** 生成模式会话最终可调用工具的唯一合法清单。 */
const GENERATION_TOOL_ALLOWLIST = ["read"] as const;
/** 明确不得暴露的内置工具（断言失败信息用）。 */
const FORBIDDEN_TOOLS = ["bash", "powershell", "write", "edit", "grep", "find", "ls"] as const;

/** 把 FlowLink 内置 Skill 配置转成 Pi SDK 的 Skill 对象（供 skillsOverride 注入）。 */
export function toSdkSkills(skills: PiSkillConfig[]): Skill[] {
	return skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.skillFile,
		baseDir: skill.baseDir,
		sourceInfo: createSyntheticSourceInfo(skill.skillFile, {
			source: "local",
			baseDir: skill.baseDir,
		}),
		disableModelInvocation: false,
	}));
}

/** 受限 read 的读取 allowlist：全部为真实绝对路径。 */
export function buildReadAllowlist(skills: PiSkillConfig[]): Set<string> {
	const allowlist = new Set<string>();
	for (const skill of skills) {
		allowlist.add(normalizeRealPath(skill.skillFile));
		for (const reference of skill.referenceFiles) {
			allowlist.add(normalizeRealPath(reference));
		}
	}
	return allowlist;
}

function normalizeRealPath(realPath: string): string {
	return process.platform === "win32" ? realPath.toLowerCase() : realPath;
}

export interface RestrictedReadOptions {
	/** 可读文件的真实绝对路径集合（buildReadAllowlist 产物）。 */
	allowlist: Set<string>;
	/** 每请求累计读取预算（字符）；默认 SKILL_READ_BUDGET_CHARS。 */
	budgetChars?: number;
}

/**
 * 唯一自定义受限 read 工具。工具名锁定为 "read"：Pi 原生 Skills 提示段只认 read/bash 命名，
 * 不得改名；自定义工具以该名注册会覆盖 SDK 注册表的同名内置槽位，成为模型唯一可见的 read。
 */
export function createRestrictedReadTool(options: RestrictedReadOptions): ToolDefinition {
	const budgetChars = options.budgetChars ?? SKILL_READ_BUDGET_CHARS;
	const allowlist = new Set(
		[...options.allowlist].map((entry) => normalizeRealPath(entry)),
	);
	let usedChars = 0;

	return defineTool({
		name: "read",
		label: "read",
		description:
			`Read a built-in FlowLink skill file (a SKILL.md or a reference file listed in its frontmatter). ` +
			`Only files inside the app's built-in skill directory can be read; other paths are rejected. ` +
			`Reading is bounded to ${budgetChars} characters per request.`,
		promptSnippet: "Read built-in skill files",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the built-in skill file to read" }),
			offset: Type.Optional(
				Type.Number({ description: "Line number to start reading from (1-indexed)" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of lines to read" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requested = params.path;
			try {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (typeof requested !== "string" || !requested.trim()) {
					throw new Error("read requires a file path.");
				}
				const cwd = ctx?.cwd || process.cwd();
				const resolved = resolve(cwd, requested);

				let stats;
				try {
					stats = statSync(resolved);
				} catch {
					throw new Error(
						`read rejected: '${requested}' does not exist. Only built-in skill files are readable.`,
					);
				}
				if (!stats.isFile()) {
					throw new Error(
						`read rejected: '${requested}' is not a regular file; directories are not readable.`,
					);
				}
				let real: string;
				try {
					real = realpathSync(resolved);
				} catch {
					throw new Error(
						`read rejected: '${requested}' could not be resolved to a real path.`,
					);
				}
				if (!allowlist.has(normalizeRealPath(real))) {
					throw new Error(
						`read rejected: '${requested}' is outside the built-in skill files allowlist. ` +
							"Only SKILL.md files and their listed reference files inside the app's skill directory can be read.",
					);
				}

				let text = readFileSync(real, "utf8");
				if (text.includes("\u0000")) {
					throw new Error(`read rejected: '${requested}' looks like a binary file.`);
				}
				if (params.offset !== undefined || params.limit !== undefined) {
					const lines = text.split("\n");
					const start =
						params.offset !== undefined
							? Math.max(0, Math.floor(params.offset) - 1)
							: 0;
					if (start >= lines.length && lines.length > 0) {
						throw new Error(
							`Offset ${params.offset} is beyond end of file (${lines.length} lines total)`,
						);
					}
					const end =
						params.limit !== undefined
							? Math.min(lines.length, start + Math.max(0, Math.floor(params.limit)))
							: lines.length;
					text = lines.slice(start, end).join("\n");
				}

				const remaining = budgetChars - usedChars;
				if (text.length > remaining) {
					throw new Error(
						`read rejected: skill read budget exhausted. This read needs ${text.length} characters ` +
							`but only ${remaining} of ${budgetChars} remain for this request. ` +
							"Reading is never silently truncated.",
					);
				}
				usedChars += text.length;
				appLog(
					"info",
					"pi-skill-read",
					appLogFields({ file: real, chars: text.length, budgetUsed: usedChars, budget: budgetChars }),
				);
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			} catch (error) {
				appLog(
					"warn",
					"pi-skill-read",
					appLogFields({
						path: requested,
						reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
					}),
				);
				throw error;
			}
		},
	});
}

/**
 * 断言生成模式会话的最终工具注册表仅含受限 read。
 * 断言失败（如内置 read 残留、其他工具暴露）属阻塞缺陷：重新评估设计，
 * 不得改名绕过、不得开放默认 read 或 shell。
 */
export function assertGenerationToolRegistry(activeToolNames: string[]): void {
	const sorted = [...activeToolNames].sort();
	const expected = [...GENERATION_TOOL_ALLOWLIST].sort();
	const same =
		sorted.length === expected.length && sorted.every((name, index) => name === expected[index]);
	if (same) return;
	const forbidden = FORBIDDEN_TOOLS.filter((name) => activeToolNames.includes(name));
	throw new Error(
		`BLOCKING: Pi generation session tool registry assertion failed — expected exactly [${expected.join(", ")}], ` +
			`got [${activeToolNames.join(", ")}]${forbidden.length ? ` (forbidden tools exposed: ${forbidden.join(", ")})` : ""}. ` +
			"The restricted-mode design requires re-evaluation; the read tool must not be renamed or replaced by the default reader.",
	);
}
