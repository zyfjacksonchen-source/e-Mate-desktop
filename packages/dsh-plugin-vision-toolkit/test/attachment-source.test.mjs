import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'
import { withResolvedVisionGlanceImages } from '../src/attachment-source.ts'

const attachmentId = `sha256:${'a'.repeat(64)}`
const attachment = {
  attachmentId,
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
  name: 'generated.png',
}

test('vision_glance resolves only an exact current-session image attachment', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'e-mate-vision-workspace-'))
  const reads = []
  let stagedPath
  const signal = new AbortController().signal
  const ctx = { attachments: { async readImage(ref, nextSignal) {
    reads.push([ref, nextSignal])
    return { data: Uint8Array.of(1, 2, 3, 4) }
  } } }
  const exec = {
    signal,
    agent: { session: { header: { cwd: workspace },
      deriveMessages: () => [],
      events: [{ type: 'emate/image-output', data: { output: attachment, content: [{ type: 'image', attachment }] } }],
    } },
  }

  const result = await withResolvedVisionGlanceImages(ctx, [attachmentId], exec, async images => {
    stagedPath = images[0]
    assert.equal(isAbsolute(stagedPath), true)
    assert.equal(relative(workspace, stagedPath).startsWith('..'), false)
    assert.deepEqual(await readFile(stagedPath), Buffer.from([1, 2, 3, 4]))
    return 'ok'
  })

  assert.equal(result, 'ok')
  assert.deepEqual(reads, [[attachment, signal]])
  await assert.rejects(stat(stagedPath), { code: 'ENOENT' })
  await rm(workspace, { recursive: true, force: true })
})

test('vision_glance rejects an attachment id outside the current Agent session', async () => {
  const exec = { signal: new AbortController().signal, agent: { session: { deriveMessages: () => [], events: [] } } }
  await assert.rejects(
    withResolvedVisionGlanceImages({ attachments: { readImage: async () => assert.fail('must not read') } }, [attachmentId], exec, async () => {}),
    error => error?.name === 'VisionToolkitError' && error?.code === 'input'
      && /not present in the current Agent session/u.test(error.message),
  )
})

test('vision_glance fails typed before reading when the Agent workspace is unavailable', async () => {
  const exec = { agent: { session: { deriveMessages: () => [{ content: [{ type: 'image', attachment }] }] } } }
  await assert.rejects(
    withResolvedVisionGlanceImages({ attachments: { readImage: async () => assert.fail('must not read') } }, [attachmentId], exec, async () => {}),
    error => error?.name === 'VisionToolkitError' && error?.code === 'input'
      && /absolute current Agent workspace/u.test(error.message),
  )
})

test('vision_glance leaves ordinary workspace paths unchanged and preserves cancellation', async () => {
  const paths = ['input.png']
  let received
  await withResolvedVisionGlanceImages({}, paths, {}, async images => { received = images })
  assert.equal(received, paths)

  const controller = new AbortController()
  controller.abort(new Error('cancelled by caller'))
  await assert.rejects(
    withResolvedVisionGlanceImages({}, [attachmentId], { signal: controller.signal }, async () => {}),
    /cancelled by caller/u,
  )
})

// Compaction may remove image blocks from deriveMessages while the owning
// session's durable events retain the exact attachment references.
test('vision_glance reads historical user, assistant and tool images after compaction', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'e-mate-vision-history-'))
  const content = [{ type: 'image', attachment }]
  const events = [
    { type: 'user/message', data: { content } },
    { type: 'assistant/message', data: { message: { content } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content }] } } },
  ]
  try {
    for (const event of events) {
      const exec = { agent: { session: { header: { cwd: workspace },
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '分析之前的图片' }] }],
        events: [event],
      } } }
      let staged
      await withResolvedVisionGlanceImages({ attachments: { readImage: async ref => {
        assert.deepEqual(ref, attachment)
        return { data: Uint8Array.of(1, 2, 3, 4) }
      } } }, [attachmentId], exec, async images => {
        staged = images[0]
        assert.deepEqual(await readFile(staged), Buffer.from([1, 2, 3, 4]))
      })
      await assert.rejects(stat(staged), { code: 'ENOENT' })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
