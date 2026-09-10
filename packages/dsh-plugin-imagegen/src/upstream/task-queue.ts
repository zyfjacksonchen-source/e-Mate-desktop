// e-Mate adaptation: resource-settlement hook and release of persisted image payloads; see SOURCE.md.
/** In-memory, host-resident image generation queue. */

import { randomUUID } from 'node:crypto'
import type { GenerateRequest, GenerateResult, GenerationTask } from './protocol.ts'

export type GenerationTaskListener = (task: GenerationTask) => void

export class GenerationTaskQueue {
  private readonly tasks: GenerationTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<GenerationTaskListener>()
  private running = 0
  private readonly completions = new Map<string, Promise<void>>()

  constructor(
    private readonly run: (request: GenerateRequest, signal: AbortSignal) => Promise<GenerateResult>,
    private readonly concurrency = 1,
  ) {}

  list(): GenerationTask[] {
    return this.tasks.map(task => this.snapshot(task))
  }

  /** Observe queue state changes. Listener failures never disrupt generation. */
  subscribe(listener: GenerationTaskListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  submit(request: GenerateRequest): GenerationTask {
    const task: GenerationTask = { id: randomUUID(), request: { ...request }, status: 'queued', createdAt: Date.now() }
    this.tasks.unshift(task)
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  /** e-Mate native Job settles only after provider resources are released. */
  async settled(id: string): Promise<void> { await this.completions.get(id) }

  /** Drop large provider payloads once native CAS and Session persistence own them. */
  releaseImages(id: string): void {
    const task = this.tasks.find(item => item.id === id)
    if (task?.result) task.result = { ...task.result, images: [] }
    if (task) { delete task.request.image; delete task.request.images }
  }

  /** e-Mate: native Session receipts own old completed tasks after cache eviction. */
  forget(id: string): void {
    const index = this.tasks.findIndex(task => task.id === id)
    if (index >= 0 && ['completed', 'failed', 'cancelled'].includes(this.tasks[index]!.status)
      && !this.completions.has(id)) this.tasks.splice(index, 1)
  }

  cancel(id: string): GenerationTask | undefined {
    const task = this.tasks.find(item => item.id === id)
    if (task === undefined || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return task
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.controllers.get(id)?.abort()
    this.publish(task)
    this.drain()
    return this.snapshot(task)
  }

  retry(id: string): GenerationTask | undefined {
    const previous = this.tasks.find(item => item.id === id)
    return previous === undefined ? undefined : this.submit(previous.request)
  }

  /** Start tasks while their single-image request cost fits the host-wide budget. */
  private drain(): void {
    while (this.running < Math.max(1, this.concurrency)) {
      const task = this.tasks.find(item => item.status === 'queued')
      if (task === undefined) return
      // e-Mate: each upstream task fans out n single-image HTTP requests.
      // Reuse this queue's existing capacity as that exact request budget.
      const cost = Math.max(1, Math.min(4, Math.round(task.request.n)))
      if (this.running + cost > Math.max(1, this.concurrency)) return
      this.running += cost
      const completion = this.runTask(task).finally(() => {
        this.running -= cost
        this.drain()
        this.completions.delete(task.id)
      })
      this.completions.set(task.id, completion)
    }
  }

  private async runTask(task: GenerationTask): Promise<void> {
    task.status = 'running'
    task.startedAt = Date.now()
    this.publish(task)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    try {
      const result = await this.run(task.request, controller.signal)
      // Cancellation cannot erase images that another admitted request returned.
      task.result = result
      if (result.errors?.length) task.error = result.errors.join('; ')
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'completed'
        task.finishedAt = Date.now()
        this.publish(task)
      }
    } catch (error) {
      if (this.tasks.find(item => item.id === task.id)?.status !== 'cancelled') {
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.finishedAt = Date.now()
        this.publish(task)
      }
    } finally {
      this.controllers.delete(task.id)
    }
  }

  private publish(task: GenerationTask): void {
    const snapshot = this.snapshot(task)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Observers must not be able to interrupt the queue pump.
      }
    }
  }

  private snapshot(task: GenerationTask): GenerationTask {
    return {
      ...task,
      request: { ...task.request },
      ...task.result === undefined ? {} : { result: task.result },
    }
  }
}
