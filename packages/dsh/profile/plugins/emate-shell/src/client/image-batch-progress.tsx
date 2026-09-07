import { memo, useCallback, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { MessageImage } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ImageBatchClientBatch, ImageBatchClientTask, ImageBatchClientTaskState } from './image-batch-client.ts'
import { parseImageOutputReceipt } from './image-gallery-contract.ts'
import css from './image-batch-progress.module.css'

interface UseSessions {
  <T>(selector: (snapshot: SessionListState) => T, equal?: (left: T, right: T) => boolean): T
}

export interface ImageBatchRetryTask {
  readonly ordinal: number
  readonly prompt: string
  readonly imageIds: readonly string[]
}

export interface ImageBatchRetryCall {
  readonly parentCallId: string
  readonly tasks: readonly ImageBatchRetryTask[]
}

export interface ImageBatchRetryResult {
  readonly prepared: boolean
  readonly message: string
}

interface ImageBatchProgressProps {
  readonly batches: readonly ImageBatchClientBatch[]
  readonly retryCalls?: readonly ImageBatchRetryCall[]
  readonly prepareRetry?: (task: ImageBatchRetryTask) => Promise<ImageBatchRetryResult>
  readonly useSessions: UseSessions
  readonly loadImage: (attachment: ImageAttachmentRef, ownerSessionId?: string) => Promise<string>
  readonly addImageToCanvas?: (attachment: ImageAttachmentRef, ownerSessionId: string) => Promise<void>
}

interface ExactPreview {
  readonly attachment: ImageAttachmentRef
  readonly ownerSessionId: string
}

const stateLabels: Readonly<Record<ImageBatchClientTaskState, string>> = {
  queued: '排队中',
  running: '正在生成',
  'needs-review': '待确认',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
  unknown: '结果未知',
  interrupted: '未开始',
}

const batchStatusLabels = {
  completed: '全部完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
} as const

function batchLiveSummary(tasks: readonly ImageBatchClientTask[]): string {
  const count = (state: ImageBatchClientTaskState): number => tasks.filter(task => task.state === state).length
  const failure = tasks.filter(task => ['failed', 'cancelled', 'unknown', 'interrupted'].includes(task.state)).length
  return [
    '批次进度',
    '排队 ' + count('queued'),
    '生成中 ' + count('running'),
    '待确认 ' + count('needs-review'),
    '完成 ' + count('completed'),
    '未完成 ' + failure,
  ].join('，')
}

const imageLabels = {
  image: '图像',
  open: '查看原图',
  openNamed: (label: string) => '查看原图：' + label,
  loading: '正在加载图像…',
  loadFailed: '图像加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图预览' },
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactPreview(sessions: SessionListState, task: ImageBatchClientTask): ExactPreview | undefined {
  const childSessionId = task.childSessionId
  const pointer = task.receipt
  if (childSessionId === undefined || pointer === undefined || pointer.ownerSessionId !== childSessionId
    || (pointer.status !== 'completed' && pointer.status !== 'needs-review')) return undefined
  const values = sessions.byId[childSessionId]?.projectionValues as Readonly<Record<string, unknown>> | undefined
  const rows = values?.eMateImageReceipts
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (!record(row) || row.seq !== pointer.eventSeq || !record(row.receipt)) continue
    const receipt = row.receipt
    if (receipt.parent_session_id !== childSessionId || receipt.child_session_id !== undefined
      || receipt.call_id !== pointer.callId || receipt.revision !== pointer.revision || receipt.status !== pointer.status) continue
    const item = parseImageOutputReceipt(receipt)
    if (item?.attachment === undefined) return undefined
    return { attachment: item.attachment, ownerSessionId: childSessionId }
  }
  return undefined
}

function samePreview(left: ExactPreview | undefined, right: ExactPreview | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.ownerSessionId !== right.ownerSessionId) return false
  const a = left.attachment; const b = right.attachment
  return a.attachmentId === b.attachmentId && a.mediaType === b.mediaType && a.bytes === b.bytes
    && a.width === b.width && a.height === b.height && a.name === b.name
}

const ImageBatchTaskCard = memo(function ImageBatchTaskCard({ task, retry, prepareRetry, useSessions, loadImage, addImageToCanvas }: {
  readonly task: ImageBatchClientTask
  readonly retry?: ImageBatchRetryTask
  readonly prepareRetry?: ImageBatchProgressProps['prepareRetry']
  readonly useSessions: UseSessions
  readonly loadImage: ImageBatchProgressProps['loadImage']
  readonly addImageToCanvas?: ImageBatchProgressProps['addImageToCanvas']
}) {
  const preview = useSessions(sessions => exactPreview(sessions, task), samePreview)
  const loadPreview = useCallback(
    (attachment: ImageAttachmentRef) => loadImage(attachment, preview?.ownerSessionId),
    [loadImage, preview?.ownerSessionId],
  )
  const [retryMessage, setRetryMessage] = useState<string>()
  const [preparing, setPreparing] = useState(false)
  const adding = useRef(false)
  const [addingToCanvas, setAddingToCanvas] = useState(false)
  const [canvasError, setCanvasError] = useState<string>()
  const addToCanvas = (): void => {
    if (!addImageToCanvas || !preview || task.receipt?.status !== 'completed' || adding.current) return
    adding.current = true; setAddingToCanvas(true); setCanvasError(undefined)
    void addImageToCanvas(preview.attachment, preview.ownerSessionId).catch(() => {
      setCanvasError('图片未能加入画布，请确认附件仍可用后重试。')
    }).finally(() => { adding.current = false; setAddingToCanvas(false) })
  }
  const label = '第 ' + task.ordinal + ' 张图片：' + stateLabels[task.state]
  const retryable = task.terminal && task.state !== 'completed' && retry !== undefined && prepareRetry !== undefined
  const sourceReason = retry?.imageIds.length ? '带参考图的任务暂不能安全准备重试，请重新附图后发送。' : undefined
  const prepare = (): void => {
    if (!retryable || sourceReason !== undefined || preparing) return
    setPreparing(true)
    void prepareRetry(retry).then(result => { setRetryMessage(result.message) }, () => {
      setRetryMessage('未能准备重试，请保持当前草稿不变并稍后再试。')
    }).finally(() => { setPreparing(false) })
  }
  return <article className={css.card} data-task-id={task.taskId} data-state={task.state} aria-label={label}>
    <div className={css.preview}>
      {preview === undefined
        ? <div className={css.placeholder} aria-hidden="true"><span /></div>
        : <MessageImage
            attachment={preview.attachment}
            load={loadPreview}
            variant="tile"
            labels={imageLabels}
          />}
    </div>
    <div className={css.meta}>
      <strong>图片 {task.ordinal}</strong>
      <span>{stateLabels[task.state]}</span>
    </div>
    {addImageToCanvas && task.receipt && <div className={css.canvasAction} data-pending={addingToCanvas || undefined}>
      <button type="button" aria-label={`加入画布：图片 ${task.ordinal}`}
        disabled={!preview || task.receipt.status !== 'completed' || addingToCanvas}
        title={!preview ? '正在核对图片附件' : task.receipt.status !== 'completed' ? '图片仍待确认' : '加入画布'}
        onClick={addToCanvas}>{addingToCanvas ? '正在加入…' : '加入画布'}</button>
    </div>}
    {canvasError && <p role="status" className={css.reason}>{canvasError}</p>}
    {task.state === 'unknown' && <p className={css.reason}>结果不确定，未自动重复生成</p>}
    {task.state === 'cancelled' && <p className={css.reason}>已取消；已完成图片仍会保留</p>}
    {task.state === 'interrupted' && <p className={css.reason}>任务未开始；未自动重新生成</p>}
    {task.state === 'failed' && <p className={css.reason}>生成失败；未自动重新生成</p>}
    {retryable && <div className={css.retry}>
      <button type="button" disabled={sourceReason !== undefined || preparing} onClick={prepare}>
        {preparing ? '正在准备…' : '准备重新生成此项'}
      </button>
      {(sourceReason ?? retryMessage) !== undefined && <p>{sourceReason ?? retryMessage}</p>}
    </div>}
  </article>
})

/**
 * Render batches owned by exact image_batch calls in one parent Turn.
 * @param props - exact parent batches, native child Session hook, and Attachment image loader.
 * @returns the live batch cards, or null until an exact parent batch is projected.
 */
export function ImageBatchProgress({
  batches, retryCalls = [], prepareRetry, useSessions, loadImage, addImageToCanvas,
}: ImageBatchProgressProps) {
  const retries = new Map(retryCalls.flatMap(call => call.tasks.map(task => [
    call.parentCallId + '\0' + task.ordinal, task,
  ] as const)))
  if (batches.length === 0) return null
  return <div className={css.root} aria-label="图片批次进度">
    {batches.map(batch => {
      const failures = batch.tasks.filter(task => task.terminal && task.state !== 'completed')
      const batchLabel = '图片批次，共 ' + batch.tasks.length + ' 张'
        + (batch.status === undefined ? '' : '，' + batchStatusLabels[batch.status])
      return <section
        key={batch.batchId}
        className={css.batch}
        aria-label={batchLabel}
        aria-busy={!batch.terminal}
        data-batch-id={batch.batchId}
      >
        <p className={css.liveSummary} aria-live="polite" aria-atomic="true">
          {batchLiveSummary(batch.tasks)}
        </p>
        {!batch.terminal && <p className={css.cancelGuidance}>
          如需取消，请使用输入框旁的“停止生成”按钮。
        </p>}
        <div className={css.grid} role="list">
          {batch.tasks.map(task => <div key={task.taskId} role="listitem">
            <ImageBatchTaskCard
              task={task}
              retry={retries.get(batch.parentCallId + '\0' + task.ordinal)}
              prepareRetry={prepareRetry}
              useSessions={useSessions}
              loadImage={loadImage}
              addImageToCanvas={addImageToCanvas}
            />
          </div>)}
        </div>
        {batch.terminal && failures.length > 0 && <section
          className={css.failures}
          tabIndex={0}
          aria-label={'批次未完成项目：' + failures.length + ' 项'}
        >
          <strong>未完成 {failures.length} 项</strong>
          <ul>
            {failures.map(task => <li key={task.taskId}>
              图片 {task.ordinal}：{stateLabels[task.state]}
              {task.failureCode === undefined ? '' : '（代码：' + task.failureCode + '）'}
            </li>)}
          </ul>
        </section>}
      </section>
    })}
  </div>
}
