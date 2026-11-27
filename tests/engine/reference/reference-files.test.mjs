/**
 * Reference 文件持久化路径规划永久回归测试（openspec change: formalize-reference）。
 *
 * 覆盖：文件名清洗（穿越/非法字符/CJK/扩展名）、碰撞去重序号、路径逃逸拒绝、
 * isInsideDirectory 边界、临时目录写-删往返（模拟主进程 IPC 落盘行为）。
 */
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { bundle, cleanupBundleTemp } from '../../helpers/bundle.mjs'

let tempDir
let files


before(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'flowlink-reference-files-'))
	files = await bundle('engine/reference/src/files.ts', 'files')
})

after(async () => {
	if (tempDir) await rm(tempDir, { recursive: true, force: true })
	await cleanupBundleTemp()
})

describe('4.3 Reference 文件持久化（纯函数部分）', () => {
	test('文件名清洗：保留可读名与扩展名，剥离穿越与非法字符', () => {
		assert.equal(files.sanitizeReferenceFileName('客户清单.docx'), '客户清单.docx')
		assert.equal(files.sanitizeReferenceFileName('../../evil.txt'), 'evil.txt')
		assert.equal(files.sanitizeReferenceFileName('a/b\\c.xlsx'), 'c.xlsx')
		assert.equal(files.sanitizeReferenceFileName('a<b>:c?*.csv'), 'a_b__c__.csv')
		assert.equal(files.sanitizeReferenceFileName('..'), 'unnamed')
		assert.equal(files.sanitizeReferenceFileName(''), 'unnamed')
		const long = `${'x'.repeat(200)}.docx`
		assert.ok(files.sanitizeReferenceFileName(long).length <= 100)
	})

	test('碰撞去重：同名追加 -2/-3 序号（大小写不敏感）', () => {
		const dir = join(tempDir, 'plan-a')
		const first = files.planReferenceFileTarget(dir, '报告.docx', [])
		assert.equal(first.fileName, '报告.docx')
		assert.equal(first.relativePath, 'references/报告.docx')
		assert.ok(first.absolutePath.startsWith(dir))
		const second = files.planReferenceFileTarget(dir, '报告.docx', ['报告.docx'])
		assert.equal(second.fileName, '报告-2.docx')
		assert.equal(second.displayName, '报告.docx', '显示名保持原始名')
		const third = files.planReferenceFileTarget(dir, '报告.DOCX', ['报告.docx', '报告-2.docx'])
		assert.equal(third.fileName, '报告-3.docx')
	})

	test('路径逃逸拒绝：清洗后的目标必须落在目录内', () => {
		const dir = join(tempDir, 'plan-b')
		const plan = files.planReferenceFileTarget(dir, '../../../etc/passwd', [])
		assert.equal(files.isInsideDirectory(dir, plan.absolutePath), true)
		assert.ok(!plan.absolutePath.includes('etc'))
	})

	test('isInsideDirectory 边界', () => {
		const dir = join(tempDir, 'inside')
		assert.equal(files.isInsideDirectory(dir, join(dir, 'a.txt')), true)
		assert.equal(files.isInsideDirectory(dir, dir), false)
		assert.equal(files.isInsideDirectory(dir, join(dir, '..', 'escape.txt')), false)
	})

	test('写-删往返：计划路径落盘后可见、删除后消失', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowlink-ref-roundtrip-'))
		try {
			const referencesDir = join(root, 'references')
			const plan = files.planReferenceFileTarget(referencesDir, '附件.docx', [])
			await mkdir(referencesDir, { recursive: true })
			await writeFile(plan.absolutePath, Uint8Array.from([1, 2, 3]))
			const listed = await readdir(referencesDir)
			assert.deepEqual(listed, ['附件.docx'])
			const again = files.planReferenceFileTarget(referencesDir, '附件.docx', listed)
			assert.equal(again.fileName, '附件-2.docx')
			await rm(plan.absolutePath)
			await assert.rejects(access(plan.absolutePath))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
