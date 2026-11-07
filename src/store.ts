/**
 * 任务存储：FlowLink 的任务（= 列表里的一行流程）持久化在 userData/flowlink/tasks.json。
 * 每个任务挂多条录制（RecordingMeta），录制指向引擎产出的 flow JSON 与 artifacts 目录。
 * 原子写（tmp + rename），读失败按空库处理（不阻塞应用启动）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface TaskVersion {
	name: string
	enabled: boolean
}

export interface RecordingLastRun {
	ok: boolean
	at: string
	pass: number
	fail: number
}

export interface RecordingMeta {
	id: string
	name: string
	/** flow JSON 的绝对路径 */
	flowFile: string
	/** 该 flow 的 artifacts 根目录（绝对路径） */
	artifactsDir: string
	createdAt: string
	steps: number
	videoFile?: string
	posterFile?: string
	frames?: string[]
	stepScreenshots?: string[]
	lastRun?: RecordingLastRun
}

export interface Task {
	code: string
	name: string
	description: string
	serviceLines: string[]
	versions: TaskVersion[]
	version: string
	category: string
	status: string
	enabled: boolean
	recordings: RecordingMeta[]
	createdAt: string
	updatedAt: string
}

export type TaskProfilePatch = Pick<
	Task,
	'code' | 'name' | 'description' | 'serviceLines' | 'versions' | 'version' | 'category' | 'status' | 'enabled'
>

interface TasksFile {
	tasks: Task[]
}

export class TaskStore {
	private tasks = new Map<string, Task>()
	private loaded = false

	constructor(private readonly file: string) {}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return
		this.loaded = true
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8')) as TasksFile
			for (const task of raw.tasks ?? []) {
				if (task && typeof task.code === 'string') {
					this.tasks.set(task.code, { recordings: [], serviceLines: ['', '', '', ''], ...task })
				}
			}
		} catch {
			/* 首次启动 / 文件损坏：按空库处理 */
		}
	}

	private async persist(): Promise<void> {
		const data: TasksFile = { tasks: this.list() }
		await mkdir(dirname(this.file), { recursive: true })
		const tmp = `${this.file}.tmp`
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
		await rename(tmp, this.file)
	}

	list(): Task[] {
		return [...this.tasks.values()].sort((a, b) => a.code.localeCompare(b.code))
	}

	get(code: string): Task | undefined {
		return this.tasks.get(code)
	}

	/** 新建或整体更新 Profile 字段（ recordings 不动） */
	async upsertProfile(patch: TaskProfilePatch): Promise<Task> {
		await this.ensureLoaded()
		const now = new Date().toISOString()
		const existing = this.tasks.get(patch.code)
		const task: Task = existing
			? { ...existing, ...patch, updatedAt: now }
			: { ...patch, recordings: [], createdAt: now, updatedAt: now }
		this.tasks.set(task.code, task)
		await this.persist()
		return task
	}

	async remove(code: string): Promise<void> {
		await this.ensureLoaded()
		this.tasks.delete(code)
		await this.persist()
	}

	/** 录制停止后登记一条录制；任务还不存在（没保存过 Profile）时先补一个壳 */
	async addRecording(code: string, recording: RecordingMeta): Promise<Task> {
		await this.ensureLoaded()
		const now = new Date().toISOString()
		const task =
			this.tasks.get(code) ??
			({
				code,
				name: '',
				description: '',
				serviceLines: ['', '', '', ''],
				versions: [{ name: 'V1', enabled: false }],
				version: 'r1',
				category: '',
				status: 'Ready',
				enabled: false,
				recordings: [],
				createdAt: now,
				updatedAt: now,
			} satisfies Task)
		task.recordings.push(recording)
		task.updatedAt = now
		this.tasks.set(code, task)
		await this.persist()
		return task
	}

	async removeRecording(code: string, recordingId: string): Promise<Task | undefined> {
		await this.ensureLoaded()
		const task = this.tasks.get(code)
		if (!task) return undefined
		task.recordings = task.recordings.filter((item) => item.id !== recordingId)
		task.updatedAt = new Date().toISOString()
		await this.persist()
		return task
	}

	async patchRecording(
		code: string,
		recordingId: string,
		patch: Partial<RecordingMeta>,
	): Promise<void> {
		await this.ensureLoaded()
		const task = this.tasks.get(code)
		const recording = task?.recordings.find((item) => item.id === recordingId)
		if (!recording) return
		Object.assign(recording, patch)
		await this.persist()
	}
}
