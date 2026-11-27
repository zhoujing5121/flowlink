/**
 * Reference 附件原子保存永久回归测试（openspec change: formalize-reference 修订轮 3）。
 *
 * 覆盖：附件写入/替换/删除往返（文件与元数据同步）、非法目标拒绝、
 * 元数据落盘失败回滚新写文件、孤儿旧文件清理、闸门的附件注入与缺失检查。
 */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bundle, cleanupBundleTemp } from '../../helpers/bundle.mjs'

let tempDir
let persistence
let flowIO


function baseFlowFile(artifactsRoot, name = 'flow.json') {
	return join(artifactsRoot, name)
}

function baseFlowRaw() {
	return {
		schemaVersion: 3,
		id: 'flow_att',
		title: '附件测试',
		version: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		meta: {
			env: { startUrl: 'https://example.local/', viewport: { width: 1280, height: 800 } },
			recorder: { name: 'rr', version: '0.1.0' },
		},
		variables: [],
		referenceFiles: [],
		steps: [{ kind: 'navigate', id: 's1', url: '{{url_1}}' }],
		selfHealed: [],
	}
}

before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-ref-attachments-'))
	;[persistence, flowIO] = await Promise.all([
		bundle('electron/reference/reference-persistence.ts', 'reference-persistence'),
		bundle('engine/schema/src/io.ts', 'flow-io'),
	])
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
	await cleanupBundleTemp()
})

describe('10.3 附件原子保存', () => {
	test('写入 → 替换 → 删除往返：文件与元数据同步', async () => {
		const root = await mkdtemp(join(tempDir, 'round-'))
		const flowFile = baseFlowFile(root)
		await flowIO.saveFlow(flowIO.parseFlow(baseFlowRaw()), flowFile)
		const artifactsDir = join(root, 'artifacts')

		// 写入
		const csvVariable = { name: 'file_1', label: '客户清单', type: 'csv', secret: false, source: 'input' }
		const first = await persistence.saveVariablesWithAttachments({
			flowFile,
			artifactsDir,
			variables: [csvVariable],
			attachments: [{ name: 'file_1', fileName: '客户清单.csv', data: Uint8Array.from([1, 2, 3]) }],
		})
		assert.equal(first.variables[0].file.path, 'references/客户清单.csv')
		assert.equal(first.variables[0].file.name, '客户清单.csv')
		const stored1 = await readFile(join(artifactsDir, 'references', '客户清单.csv'))
		assert.deepEqual([...stored1], [1, 2, 3])
		const flow1 = await flowIO.loadFlow(flowFile)
		assert.equal(flow1.version, 2, '版本递增')
		assert.equal(flow1.variables[0].file.name, '客户清单.csv')

		// 替换上传：新文件落盘、旧文件删除、元数据指向新路径
		const replaced = await persistence.saveVariablesWithAttachments({
			flowFile,
			artifactsDir,
			variables: [{ ...csvVariable, file: first.variables[0].file }],
			attachments: [{ name: 'file_1', fileName: '客户清单-新版.csv', data: Uint8Array.from([9, 9]) }],
		})
		assert.equal(replaced.variables[0].file.path, 'references/客户清单-新版.csv')
		const dirAfterReplace = await readdir(join(artifactsDir, 'references'))
		assert.deepEqual(dirAfterReplace, ['客户清单-新版.csv'], '旧文件被清理')

		// 删除附件：变量省略 file → 元数据与文件一并移除
		const removed = await persistence.saveVariablesWithAttachments({
			flowFile,
			artifactsDir,
			variables: [{ ...csvVariable }],
		})
		assert.equal(removed.variables[0].file, undefined)
		assert.deepEqual(await readdir(join(artifactsDir, 'references')), [])
		await rm(root, { recursive: true, force: true })
	})

	test('非法目标拒绝：未知机器键 / 非文件类类型 / 空字节 / 重复目标', async () => {
		const root = await mkdtemp(join(tempDir, 'invalid-'))
		const flowFile = baseFlowFile(root)
		await flowIO.saveFlow(flowIO.parseFlow(baseFlowRaw()), flowFile)
		const artifactsDir = join(root, 'artifacts')
		const variables = [
			{ name: 'input_1', label: '客户名称', type: 'string', secret: false, source: 'input' },
		]
		await assert.rejects(
			persistence.saveVariablesWithAttachments({ flowFile, artifactsDir, variables, attachments: [{ name: 'ghost', fileName: 'a.csv', data: Uint8Array.from([1]) }] }),
			/目标变量不存在/,
		)
		await assert.rejects(
			persistence.saveVariablesWithAttachments({ flowFile, artifactsDir, variables, attachments: [{ name: 'input_1', fileName: 'a.csv', data: Uint8Array.from([1]) }] }),
			/只有文件类对象/,
		)
		await assert.rejects(
			persistence.saveVariablesWithAttachments({ flowFile, artifactsDir, variables, attachments: [{ name: 'input_1', fileName: 'a.csv', data: new Uint8Array(0) }] }),
			/附件上传请求无效/,
		)
		await rm(root, { recursive: true, force: true })
	})

	test('元数据落盘失败回滚新写文件（文件与元数据不脱节）', async () => {
		const root = await mkdtemp(join(tempDir, 'rollback-'))
		const flowFile = baseFlowFile(root)
		await flowIO.saveFlow(flowIO.parseFlow(baseFlowRaw()), flowFile)
		const artifactsDir = join(root, 'artifacts')
		// label 重复会让 parseFlow strict 失败 → saveFlow 前抛错
		await assert.rejects(
			persistence.saveVariablesWithAttachments({
				flowFile,
				artifactsDir,
				variables: [
					{ name: 'file_1', label: '同名', type: 'csv', secret: false, source: 'input' },
					{ name: 'file_2', label: '同名', type: 'csv', secret: false, source: 'input' },
				],
				attachments: [{ name: 'file_1', fileName: 'a.csv', data: Uint8Array.from([1]) }],
			}),
			/label "同名" 重复/,
		)
		await assert.rejects(access(join(artifactsDir, 'references', 'a.csv')), '失败后新写文件应被回滚')
		const unchanged = await flowIO.loadFlow(flowFile)
		assert.equal(unchanged.version, 1, '失败不递增版本')
		assert.equal(unchanged.variables.length, 0)
		await rm(root, { recursive: true, force: true })
	})

	test('闸门 gateReferenceVariables：附件注入绝对路径 + 缺失文件具名违规', async () => {
		const root = await mkdtemp(join(tempDir, 'gate-'))
		const artifactsDir = join(root, 'artifacts')
		await mkdir(join(artifactsDir, 'references'), { recursive: true })
		await writeFile(join(artifactsDir, 'references', '存在.csv'), Uint8Array.from([7]))
		const variables = [
			{ name: 'file_1', label: '存在附件', type: 'csv', secret: false, source: 'input', file: { name: '存在.csv', path: 'references/存在.csv' } },
			{ name: 'file_2', label: '缺失附件', type: 'file', secret: false, source: 'input', file: { name: '缺失.bin', path: 'references/缺失.bin' } },
		]
		const outcome = await persistence.gateReferenceVariables(variables, {}, artifactsDir)
		assert.equal(outcome.ok, false)
		const missing = outcome.issues.find((issue) => issue.name === 'file_2')
		assert.ok(missing, '缺失附件必须有违规')
		assert.match(missing.reason, /附件文件不存在/)
		const injected = outcome.values['file_1']
		assert.ok(injected.startsWith(artifactsDir) && injected.endsWith('存在.csv'), `注入绝对路径：${injected}`)
		await rm(root, { recursive: true, force: true })
	})
})
