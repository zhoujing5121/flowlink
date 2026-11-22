/**
 * Pi 知识/技能安全边界永久回归测试（openspec change: refine-business-grouping-pi-knowledge）。
 *
 * 覆盖：内置 Skills 只来自 config/skills、默认/home/project Skills 不加载、
 * frontmatter 非法/重名/超预算显式失败、受限 read 的 allowlist 与预算、
 * 越权路径（穿越/编码/符号链接/外部绝对路径/目录/脚本/二进制）全部拒绝、
 * 生成会话最终工具注册表仅含受限 read、AGENTS.md 预算与追加框架。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

import {
	AGENTS_KNOWLEDGE_MAX_CHARS,
	SKILL_DESCRIPTION_MAX_CHARS,
	SKILL_FILE_MAX_CHARS,
	appendAgentsKnowledge,
	createBuiltInPiConfigSource,
	loadBuiltInSkills,
	type PiSkillConfig,
} from '../src/pi-config.js'
import {
	assertGenerationToolRegistry,
	buildReadAllowlist,
	createRestrictedReadTool,
	toSdkSkills,
} from '../src/pi-skill-session.js'

let tempDir: string

before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-pi-knowledge-'))
})

after(async () => {
	await rm(tempDir, { recursive: true, force: true })
})

const VALID_SKILL_MD = [
	'---',
	'name: order-ops',
	'description: Knowledge about the order management business domain.',
	'---',
	'',
	'# Order operations',
	'',
	'Read references when the task matches.',
].join('\n')

async function writeSkill(
	skillsRoot: string,
	name: string,
	frontmatter: string[] = ['name: ' + name, 'description: Skill for ' + name + '.'],
	body = 'Body of ' + name + '.',
): Promise<string> {
	const skillDir = join(skillsRoot, name)
	await mkdir(skillDir, { recursive: true })
	const content = ['---', ...frontmatter, '---', '', body].join('\n')
	await writeFile(join(skillDir, 'SKILL.md'), content, 'utf8')
	return join(skillDir, 'SKILL.md')
}

/* ---------- 配置来源：Skills 发现与校验 ---------- */

describe('built-in skills discovery', () => {
	test('skills load only from the built-in config/skills directory', async () => {
		const configDir = join(tempDir, 'discovery-config')
		const skillsRoot = join(configDir, 'skills')
		await writeSkill(skillsRoot, 'order-ops')
		const skills = loadBuiltInSkills(skillsRoot)
		assert.equal(skills.length, 1)
		assert.equal(skills[0]!.name, 'order-ops')
		assert.equal(skills[0]!.description, 'Skill for order-ops.')
		assert.equal(realpathSync(skills[0]!.skillFile), realpathSync(join(skillsRoot, 'order-ops', 'SKILL.md')))
		assert.deepEqual(skills[0]!.referenceFiles, [])
	})

	test('missing or empty skills directory is a no-op', async () => {
		assert.deepEqual(loadBuiltInSkills(join(tempDir, 'missing-config', 'skills')), [])
		const empty = join(tempDir, 'empty-skills')
		await mkdir(empty, { recursive: true })
		assert.deepEqual(loadBuiltInSkills(empty), [])
	})

	test('nested skill directories are discovered (config/skills/<group>/<name>/SKILL.md)', async () => {
		const skillsRoot = join(tempDir, 'nested-config', 'skills')
		const nestedDir = join(skillsRoot, 'domain', 'order-ops')
		await mkdir(nestedDir, { recursive: true })
		await writeFile(join(nestedDir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
		const skills = loadBuiltInSkills(skillsRoot)
		assert.equal(skills.length, 1)
		assert.equal(skills[0]!.name, 'order-ops')
	})

	test('reference files listed in frontmatter resolve to real paths inside the skill directory', async () => {
		const skillsRoot = join(tempDir, 'reference-config', 'skills')
		const skillDir = join(skillsRoot, 'order-ops')
		await mkdir(skillDir, { recursive: true })
		await writeFile(
			join(skillDir, 'SKILL.md'),
			['---', 'name: order-ops', 'description: d.', 'references:', '  - notes.txt', '  - deep/guide.md', '---', '', 'body'].join('\n'),
			'utf8',
		)
		await writeFile(join(skillDir, 'notes.txt'), 'notes', 'utf8')
		await mkdir(join(skillDir, 'deep'), { recursive: true })
		await writeFile(join(skillDir, 'deep', 'guide.md'), 'guide', 'utf8')
		const skills = loadBuiltInSkills(skillsRoot)
		assert.equal(skills.length, 1)
		assert.equal(skills[0]!.referenceFiles.length, 2)
		assert.ok(skills[0]!.referenceFiles.every((file) => file.endsWith('.txt') || file.endsWith('guide.md')))
	})

	test('prompts templates from the real config directory still validate', () => {
		const source = createBuiltInPiConfigSource(join(process.cwd(), 'config'))
		const templates = source.loadPrompts()
		assert.ok(templates.systemPrompt.includes('Business-stage grouping method'))
		assert.ok(templates.generation.autoSanitize.includes('four quality gates'))
		assert.ok(templates.generation.refine.includes('four quality gates'))
	})
})

/* ---------- frontmatter 严格校验：显式失败并点名文件 ---------- */

describe('skill frontmatter strict validation', () => {
	async function expectRejected(name: string, frontmatter: string[], message: RegExp): Promise<void> {
		const skillsRoot = join(tempDir, 'invalid-' + name, 'skills')
		const skillFile = await writeSkill(skillsRoot, name, frontmatter)
		assert.throws(() => loadBuiltInSkills(skillsRoot), (error: unknown) => {
			assert.ok(error instanceof Error)
			assert.ok(error.message.includes(skillFile), `error must name the offending file: ${error.message}`)
			assert.match(error.message, message)
			return true
		})
	}

	test('missing name fails naming the file', async () => {
		await expectRejected('no-name', ['description: d.'], /missing a non-empty 'name'/)
	})

	test('missing description fails naming the file', async () => {
		await expectRejected('no-desc', ['name: no-desc'], /missing a non-empty 'description'/)
	})

	test('invalid name characters fail', async () => {
		await expectRejected('bad-name', ['name: Bad_Name!', 'description: d.'], /invalid/)
	})

	test('name over 64 characters fails', async () => {
		await expectRejected('long-name', ['name: ' + 'a'.repeat(65), 'description: d.'], /name exceeds 64/)
	})

	test('description over 1024 characters fails', async () => {
		await expectRejected('long-desc', ['name: long-desc', 'description: ' + 'd'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 1)], /description exceeds 1024/)
	})

	test('allowed-tools frontmatter is rejected', async () => {
		await expectRejected('toolsy', ['name: toolsy', 'description: d.', 'allowed-tools: bash, write'], /allowed-tools/)
	})

	test('shell command interpolation in frontmatter is rejected', async () => {
		await expectRejected('shelly', ['name: shelly', 'description: runs $(rm -rf) things'], /shell command interpolation/)
		await expectRejected('backticky', ['name: backticky', 'description: runs `whoami` things'], /shell command interpolation/)
	})

	test('unsupported YAML syntax fails explicitly', async () => {
		await expectRejected('yaml1', ['name: yaml1', 'description: {complex}'], /unsupported YAML syntax/)
		const skillsRoot = join(tempDir, 'invalid-yaml2', 'skills')
		const skillDir = join(skillsRoot, 'yaml2')
		await mkdir(skillDir, { recursive: true })
		await writeFile(
			join(skillDir, 'SKILL.md'),
			['---', 'name: yaml2', 'description: d.', 'metadata:', '  nested: value', '---', '', 'b'].join('\n'),
			'utf8',
		)
		assert.throws(() => loadBuiltInSkills(skillsRoot), /only '- item' list lines may be indented/)
	})

	test('duplicate skill names fail naming both files', async () => {
		const skillsRoot = join(tempDir, 'dup-config', 'skills')
		const first = await writeSkill(skillsRoot, 'order-ops')
		const second = await writeSkill(skillsRoot, 'order-ops-copy', ['name: order-ops', 'description: another.'])
		assert.throws(() => loadBuiltInSkills(skillsRoot), (error: unknown) => {
			assert.ok(error instanceof Error)
			assert.ok(error.message.includes(second) && error.message.includes(first))
			assert.match(error.message, /duplicate skill name 'order-ops'/)
			return true
		})
	})

	test('SKILL.md over 10,000 characters fails', async () => {
		const skillsRoot = join(tempDir, 'big-file-config', 'skills')
		const skillDir = join(skillsRoot, 'big-skill')
		await mkdir(skillDir, { recursive: true })
		await writeFile(
			join(skillDir, 'SKILL.md'),
			['---', 'name: big-skill', 'description: d.', '---', '', 'x'.repeat(SKILL_FILE_MAX_CHARS + 1)].join('\n'),
			'utf8',
		)
		assert.throws(() => loadBuiltInSkills(skillsRoot), /SKILL\.md exceeds 10000 characters/)
	})

	test('total descriptions over 8,000 characters fail', async () => {
		const skillsRoot = join(tempDir, 'big-desc-config', 'skills')
		// 单个 description 上限 1024，用 9 个满长度描述冲破 8,000 合计预算
		for (let i = 0; i < 9; i++) {
			await writeSkill(skillsRoot, 'desc-' + i, ['name: desc-' + i, 'description: ' + String(i).repeat(1_000)])
		}
		assert.throws(() => loadBuiltInSkills(skillsRoot), /total skill descriptions exceed 8000 characters/)
	})

	test('invalid references fail naming the file', async () => {
		async function expectReferenceRejected(
			caseName: string,
			reference: string,
			message: RegExp,
		): Promise<void> {
			const skillsRoot = join(tempDir, 'ref-' + caseName, 'skills')
			const skillDir = join(skillsRoot, 'ref-skill')
			await mkdir(skillDir, { recursive: true })
			const skillFile = join(skillDir, 'SKILL.md')
			await writeFile(
				skillFile,
				['---', 'name: ref-skill', 'description: d.', 'references:', '  - ' + reference, '---', '', 'b'].join('\n'),
				'utf8',
			)
			assert.throws(() => loadBuiltInSkills(skillsRoot), (error: unknown) => {
				assert.ok(error instanceof Error)
				assert.ok(error.message.includes(skillFile), `must name file: ${error.message}`)
				assert.match(error.message, message)
				return true
			})
		}
		if (process.platform === 'win32') {
			await expectReferenceRejected('abs-win', 'C:/Windows/system.ini', /must be a relative path/)
		} else {
			await expectReferenceRejected('abs-posix', '/etc/passwd', /must be a relative path/)
		}
		await expectReferenceRejected('traversal', '../outside.md', /must not traverse/)
		await expectReferenceRejected('missing', 'nope.md', /does not exist/)
		await expectReferenceRejected('script-ext', 'helper.js', /not a plain-text file/)
	})

	test('duplicate reference entries fail', async () => {
		const skillsRoot = join(tempDir, 'ref-dup2', 'skills')
		const skillDir = join(skillsRoot, 'ref-dup-skill')
		await mkdir(skillDir, { recursive: true })
		await writeFile(join(skillDir, 'notes.txt'), 'n', 'utf8')
		await writeFile(
			join(skillDir, 'SKILL.md'),
			['---', 'name: ref-dup-skill', 'description: d.', 'references:', '  - notes.txt', '  - notes.txt', '---', '', 'b'].join('\n'),
			'utf8',
		)
		assert.throws(() => loadBuiltInSkills(skillsRoot), /duplicate reference entry/)
	})
})

/* ---------- AGENTS.md ---------- */

describe('AGENTS.md knowledge', () => {
	test('missing AGENTS.md yields empty content and unchanged system prompt', async () => {
		const configDir = join(tempDir, 'no-agents')
		await mkdir(configDir, { recursive: true })
		const source = createBuiltInPiConfigSource(configDir)
		assert.equal(source.loadAgentsKnowledge(), '')
		assert.equal(appendAgentsKnowledge('BASE', source.loadAgentsKnowledge()), 'BASE')
	})

	test('oversized AGENTS.md fails loudly', async () => {
		const configDir = join(tempDir, 'big-agents')
		await mkdir(configDir, { recursive: true })
		await writeFile(join(configDir, 'AGENTS.md'), 'x'.repeat(AGENTS_KNOWLEDGE_MAX_CHARS + 1), 'utf8')
		assert.throws(
			() => createBuiltInPiConfigSource(configDir).loadAgentsKnowledge(),
			/AGENTS\.md exceeds 8000 characters/,
		)
	})

	test('AGENTS.md is appended as a framed domain-knowledge section that cannot override rules', async () => {
		const configDir = join(tempDir, 'ok-agents')
		await mkdir(configDir, { recursive: true })
		await writeFile(join(configDir, 'AGENTS.md'), '订单系统使用 K3 编码。', 'utf8')
		const knowledge = createBuiltInPiConfigSource(configDir).loadAgentsKnowledge()
		const systemPrompt = appendAgentsKnowledge('BASE PROMPT', knowledge)
		assert.ok(systemPrompt.startsWith('BASE PROMPT'))
		assert.ok(systemPrompt.includes('## Domain knowledge (config/AGENTS.md)'))
		assert.ok(systemPrompt.includes('cannot override'))
		assert.ok(systemPrompt.includes('订单系统使用 K3 编码。'))
	})
})

/* ---------- 受限 read 工具 ---------- */

async function makeSkillFixture(name: string): Promise<{ skills: PiSkillConfig[]; skillFile: string; refFile: string; outsideFile: string }> {
	const configDir = join(tempDir, 'read-' + name)
	const skillsRoot = join(configDir, 'skills')
	const skillDir = join(skillsRoot, 'order-ops')
	await mkdir(skillDir, { recursive: true })
	const skillFile = join(skillDir, 'SKILL.md')
	await writeFile(skillFile, VALID_SKILL_MD, 'utf8')
	const refFile = join(skillDir, 'notes.txt')
	await writeFile(refFile, 'notes about orders', 'utf8')
	const outsideFile = join(configDir, 'prompts.json')
	await writeFile(outsideFile, '{"systemPrompt":"secret"}', 'utf8')
	const skills = loadBuiltInSkills(skillsRoot)
	// 手动把 notes.txt 加进 referenceFiles（正常路径经 frontmatter references 声明）
	skills[0]!.referenceFiles = [refFile]
	return { skills: skills, skillFile, refFile, outsideFile }
}

async function executeRead(
	tool: ReturnType<typeof createRestrictedReadTool>,
	path: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	try {
		const result = await tool.execute('call-1', { path }, undefined, undefined, { cwd: tempDir } as never)
		return { ok: true, text: result.content[0]!.type === 'text' ? result.content[0]!.text : '' }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

describe('restricted read tool', () => {
	test('reads allowlisted SKILL.md and reference files; rejects everything else', async () => {
		const { skills, skillFile, refFile, outsideFile } = await makeSkillFixture('allowlist')
		const tool = createRestrictedReadTool({ allowlist: buildReadAllowlist(skills) })

		const skill = await executeRead(tool, skillFile)
		assert.ok(skill.ok)
		assert.ok(skill.ok && skill.text.includes('# Order operations'))

		const ref = await executeRead(tool, refFile)
		assert.ok(ref.ok && ref.text === 'notes about orders')

		const outside = await executeRead(tool, outsideFile)
		assert.ok(!outside.ok)
		assert.match(!outside.ok ? outside.error : '', /outside the built-in skill files allowlist/)

		const configPrompts = await executeRead(tool, join(dirname(outsideFile), 'prompts.json'))
		assert.ok(!configPrompts.ok)

		const missing = await executeRead(tool, join(tempDir, 'no-such-file.md'))
		assert.ok(!missing.ok)
		assert.match(!missing.ok ? missing.error : '', /does not exist/)
	})

	test('rejects path traversal, encoded paths, absolute external paths, and directories', async () => {
		const { skills, skillFile } = await makeSkillFixture('traversal')
		const skillDir = dirname(skillFile)
		const tool = createRestrictedReadTool({ allowlist: buildReadAllowlist(skills) })

		const traversal = await executeRead(tool, join(skillDir, '..', '..', 'secrets.md'))
		assert.ok(!traversal.ok)

		const encoded = await executeRead(tool, 'skills%2Forder-ops%2FSKILL.md')
		assert.ok(!encoded.ok)

		const encodedTraversal = await executeRead(tool, '%2e%2e%2f%2e%2e%2fsecrets.md')
		assert.ok(!encodedTraversal.ok)

		const absolute = await executeRead(tool, 'C:/Windows/system.ini')
		assert.ok(!absolute.ok)

		const directory = await executeRead(tool, skillDir)
		assert.ok(!directory.ok)
		assert.match(!directory.ok ? directory.error : '', /not a regular file/)
	})

	test('rejects symlink escapes', async (t) => {
		const { skills, skillFile } = await makeSkillFixture('symlink')
		const skillDir = dirname(skillFile)
		const targetOutside = join(tempDir, 'read-symlink', 'outside-secret.md')
		await writeFile(targetOutside, 'escaped', 'utf8')
		const linkPath = join(skillDir, 'escaped.md')
		try {
			await symlink(targetOutside, linkPath)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'EPERM' || code === 'EACCES') {
				t.skip('creating symlinks requires privileges on this system')
				return
			}
			throw error
		}
		const tool = createRestrictedReadTool({ allowlist: buildReadAllowlist(skills) })
		const escaped = await executeRead(tool, linkPath)
		assert.ok(!escaped.ok)
		assert.match(!escaped.ok ? escaped.error : '', /outside the built-in skill files allowlist/)
	})

	test('rejects script and binary content', async () => {
		const configDir = join(tempDir, 'read-binary')
		const skillsRoot = join(configDir, 'skills')
		const skillDir = join(skillsRoot, 'order-ops')
		await mkdir(skillDir, { recursive: true })
		await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
		await writeFile(join(skillDir, 'payload.ps1'), 'Write-Host pwned', 'utf8')
		await writeFile(join(skillDir, 'blob.txt'), 'a\u0000b', 'utf8')
		const skills = loadBuiltInSkills(skillsRoot)
		skills[0]!.referenceFiles = [join(skillDir, 'blob.txt')]
		const tool = createRestrictedReadTool({ allowlist: buildReadAllowlist(skills) })

		const script = await executeRead(tool, join(skillDir, 'payload.ps1'))
		assert.ok(!script.ok)
		assert.match(!script.ok ? script.error : '', /outside the built-in skill files allowlist/)

		const binary = await executeRead(tool, join(skillDir, 'blob.txt'))
		assert.ok(!binary.ok)
		assert.match(!binary.ok ? binary.error : '', /binary/)
	})

	test('per-request budget: cumulative reads are rejected, never truncated', async () => {
		const configDir = join(tempDir, 'read-budget')
		const skillsRoot = join(configDir, 'skills')
		const skillDir = join(skillsRoot, 'order-ops')
		await mkdir(skillDir, { recursive: true })
		await writeFile(join(skillDir, 'SKILL.md'), VALID_SKILL_MD, 'utf8')
		await writeFile(join(skillDir, 'a.txt'), 'a'.repeat(60), 'utf8')
		await writeFile(join(skillDir, 'b.txt'), 'b'.repeat(50), 'utf8')
		await writeFile(join(skillDir, 'c.txt'), 'c'.repeat(120), 'utf8')
		const skills = loadBuiltInSkills(skillsRoot)
		skills[0]!.referenceFiles = [join(skillDir, 'a.txt'), join(skillDir, 'b.txt'), join(skillDir, 'c.txt')]
		const tool = createRestrictedReadTool({ allowlist: buildReadAllowlist(skills), budgetChars: 100 })

		const first = await executeRead(tool, join(skillDir, 'a.txt'))
		assert.ok(first.ok)

		const second = await executeRead(tool, join(skillDir, 'b.txt'))
		assert.ok(!second.ok)
		assert.match(!second.ok ? second.error : '', /budget exhausted/)

		const tooBig = await executeRead(tool, join(skillDir, 'c.txt'))
		assert.ok(!tooBig.ok)
		assert.match(!tooBig.ok ? tooBig.error : '', /budget exhausted/)
	})
})

/* ---------- 调用范围接线（任务 3.5/5.3）：Skills 只在两个生成入口传递 ---------- */

describe('generation-only skills wiring', () => {
	test('main.ts passes skills only at the pi:generateFlow / pi:repairFlow runPrompt callbacks', async () => {
		const mainSource = await readFile(join(process.cwd(), 'src', 'main.ts'), 'utf8')
		const wired = mainSource.match(/runPrompt: \(prompt, timeoutMs\) => runPiPrompt\(\{[^}]*\}\)/g) ?? []
		assert.equal(wired.length, 2, 'expected exactly two runPiPrompt callbacks in main.ts')
		assert.ok(
			wired.every((call) => call.includes('skills: getGenerationSkills()')),
			'both generation callbacks must pass skills: getGenerationSkills()',
		)
		const generateFlowIndex = mainSource.indexOf("'pi:generateFlow'")
		const repairFlowIndex = mainSource.indexOf("'pi:repairFlow'")
		const adviceIndex = mainSource.indexOf("'pi:prompt'")
		assert.ok(generateFlowIndex >= 0 && repairFlowIndex >= 0 && adviceIndex >= 0)
		for (const call of wired) {
			const callIndex = mainSource.indexOf(call)
			const inGeneration =
				(callIndex > generateFlowIndex && callIndex < repairFlowIndex) || callIndex > repairFlowIndex
			assert.ok(inGeneration, 'skills-wired callback must live in a generation handler')
		}
		const adviceHandler = mainSource.slice(adviceIndex, mainSource.indexOf('pi:promptTemplates'))
		assert.ok(!adviceHandler.includes('skills:'), 'advice handler must not pass skills')
		// 预热消息不带 skills；worker 仅在 request.skills 存在时进入生成模式
		const agentSource = await readFile(join(process.cwd(), 'src', 'pi-agent.ts'), 'utf8')
		const prewarmIndex = agentSource.indexOf('type: "prewarm"')
		assert.ok(prewarmIndex >= 0)
		assert.ok(!agentSource.slice(prewarmIndex - 200, prewarmIndex + 200).includes('skills'))
		const workerSource = await readFile(join(process.cwd(), 'src', 'pi-agent-worker.ts'), 'utf8')
		assert.match(workerSource, /request\.skills !== undefined/, 'worker must gate generation mode on request.skills')
	})
})

/* ---------- 生成会话工具注册表（SDK 实测断言，任务 3.4） ---------- */

async function stubSession(options: {
	cwd: string
	agentDir: string
	generation: boolean
	skills: PiSkillConfig[]
}) {
	const pi = await import('@earendil-works/pi-coding-agent')
	const generationSkills = options.generation ? toSdkSkills(options.skills) : undefined
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => 'FlowLink system prompt under test.',
		appendSystemPromptOverride: () => [],
		...(generationSkills
			? {
					skillsOverride: () => ({ skills: generationSkills, diagnostics: [] }),
				}
			: {}),
	})
	await resourceLoader.reload()
	const model = {
		provider: 'stub',
		id: 'stub-model',
		label: 'Stub Model',
		baseUrl: 'https://stub.invalid',
		input: ['text'],
		contextWindow: 100_000,
		maxOutputTokens: 4_096,
	} as never
	const created = await pi.createAgentSession({
		cwd: options.cwd,
		model,
		sessionManager: pi.SessionManager.inMemory(),
		resourceLoader,
		...(options.generation
			? {
					noTools: 'builtin' as const,
					tools: ['read'],
					customTools: [createRestrictedReadTool({ allowlist: buildReadAllowlist(options.skills) })],
				}
			: { noTools: 'all' as const }),
	})
	return { session: created.session, resourceLoader }
}

describe('generation session tool registry (SDK-level)', () => {
	test('generation session exposes exactly the restricted read; home/project skills never load; skills section injected', async () => {
		const configDir = join(tempDir, 'session-config')
		const skillsRoot = join(configDir, 'skills')
		const { skills, skillFile } = await makeSkillFixture('session')
		void skillsRoot

		// 伪造的 agentDir（用户 home）与 cwd 项目目录里各放一个 rogue skill：
		// noSkills:true + skillsOverride 下它们都不得进入会话。
		const rogueAgentDir = join(tempDir, 'session-config', 'rogue-agent')
		await mkdir(join(rogueAgentDir, 'skills', 'rogue-user'), { recursive: true })
		await writeFile(
			join(rogueAgentDir, 'skills', 'rogue-user', 'SKILL.md'),
			'---\nname: rogue-user\ndescription: rogue from home dir.\n---\n\nrogue\n',
			'utf8',
		)
		const projectDir = join(tempDir, 'session-project')
		await mkdir(join(projectDir, 'config', 'skills', 'rogue-project'), { recursive: true })
		await writeFile(
			join(projectDir, 'config', 'skills', 'rogue-project', 'SKILL.md'),
			'---\nname: rogue-project\ndescription: rogue from project dir.\n---\n\nrogue\n',
			'utf8',
		)

		const { session, resourceLoader } = await stubSession({
			cwd: projectDir,
			agentDir: rogueAgentDir,
			generation: true,
			skills,
		})
		try {
			const active = session.getActiveToolNames()
			assertGenerationToolRegistry(active)
			assert.deepEqual([...active].sort(), ['read'])

			const loaded = resourceLoader.getSkills().skills
			assert.equal(loaded.length, 1)
			assert.equal(loaded[0]!.name, 'order-ops')

			const systemPrompt = session.systemPrompt
			assert.ok(systemPrompt.includes('FlowLink system prompt under test.'))
			assert.ok(systemPrompt.includes('<available_skills>'))
			assert.ok(systemPrompt.includes('order-ops'))
			assert.ok(!systemPrompt.includes('rogue-user'))
			assert.ok(!systemPrompt.includes('rogue-project'))
		} finally {
			session.dispose()
		}
	})

	test('text-mode session keeps current behavior: no tools, no skills', async () => {
		const rogueAgentDir = join(tempDir, 'session-config', 'rogue-agent')
		const projectDir = join(tempDir, 'session-project')
		const { session, resourceLoader } = await stubSession({
			cwd: projectDir,
			agentDir: rogueAgentDir,
			generation: false,
			skills: [],
		})
		try {
			assert.deepEqual(session.getActiveToolNames(), [])
			assert.equal(resourceLoader.getSkills().skills.length, 0)
			assert.ok(!session.systemPrompt.includes('<available_skills>'))
		} finally {
			session.dispose()
		}
	})
})
