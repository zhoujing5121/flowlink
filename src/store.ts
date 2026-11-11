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
	/** 是否由 AI-assistant 合并生成 */
	isMerged?: boolean
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
	private loadPromise?: Promise<void>

	constructor(private readonly file: string) {}

	/** 只加载一次，并让并发的首次读取共享同一个 Promise 与数据快照。 */
	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return
		this.loadPromise ??= (async () => {
			try {
				const raw = JSON.parse(await readFile(this.file, 'utf8')) as TasksFile
				for (const task of raw.tasks ?? []) {
					if (task && typeof task.code === 'string') {
						this.tasks.set(task.code, {
							...task,
							recordings: task.recordings ?? [],
							serviceLines: task.serviceLines ?? ['', '', '', ''],
						})
					}
				}
			} catch {
				/* 首次启动 / 文件损坏：按空库处理 */
			} finally {
				this.loaded = true
			}
		})()
		await this.loadPromise
	}

	private async persist(): Promise<void> {
		// 临时文件与目标文件放在同一目录，确保 rename 不跨文件系统；
		// 读取方因此不会看到只写入一半的任务 JSON。
		const data: TasksFile = { tasks: await this.list() }
		await mkdir(dirname(this.file), { recursive: true })
		const tmp = `${this.file}.tmp`
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
		await rename(tmp, this.file)
	}

	async list(): Promise<Task[]> {
		await this.ensureLoaded()
		// 固定排序可让界面渲染和测试结果保持稳定。
		return [...this.tasks.values()].sort((a, b) => a.code.localeCompare(b.code))
	}

	async listMetadata(): Promise<Array<Omit<Task, 'recordings'> & { recordingCount: number }>> {
		const tasks = await this.list()
		return tasks.map(({ recordings, ...task }) => ({
			...task,
			recordingCount: recordings.length,
		}))
	}

	/** 同步查询内存缓存；需要触发初始化时，应先调用 list()。 */
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

	/** 只移除任务记录；Flow 文件和产物目录独立管理，不随之删除。 */
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

	/** 只移除一条录制的元数据，不删除对应 Flow 文件或产物。 */
	async removeRecording(code: string, recordingId: string): Promise<Task | undefined> {
		await this.ensureLoaded()
		const task = this.tasks.get(code)
		if (!task) return undefined
		task.recordings = task.recordings.filter((item) => item.id !== recordingId)
		task.updatedAt = new Date().toISOString()
		await this.persist()
		return task
	}

	/** 仅更新已存在的录制；任务或录制 ID 不存在时不执行修改。 */
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
