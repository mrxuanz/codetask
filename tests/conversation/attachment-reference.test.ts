import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import test from 'node:test'
import {
  buildAttachmentReferenceMarkdown,
  resolveMessageAttachmentAbsolutePath,
  resolveTurnAttachmentReadRoots,
  saveThreadAttachment
} from '../../src/server/conversation/attachments'
import {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests
} from '../../src/server/bootstrap'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('attachment reference paths', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-attachment-ref-'))
  bootstrapRuntime({ dataDir })

  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const threadId = '11111111-1111-4111-8111-111111111111'
  const attachment = saveThreadAttachment({
    threadId,
    name: 'hero.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png-bytes')
  })

  const ctxDataDir = getAppContext().dataDir
  const markdown = buildAttachmentReferenceMarkdown({
    threadId,
    attachments: [attachment],
    dataDir: ctxDataDir
  })

  const expectedPath = resolveMessageAttachmentAbsolutePath(threadId, attachment, ctxDataDir)
  assert.ok(expectedPath)
  assert.match(markdown, /## Reference Attachments/)
  assert.match(markdown, new RegExp(`path: ${escapeRegExp(expectedPath)}`))
  assert.match(markdown, /hero\.png/)

  const roots = resolveTurnAttachmentReadRoots({
    threadId,
    attachments: [attachment],
    dataDir: ctxDataDir
  })

  assert.equal(roots.length, 1)
  assert.equal(roots[0], dirname(expectedPath))
  assert.notEqual(roots[0], join(dataDir, 'blobs', 'attachments', threadId))
  assert.notEqual(roots[0], dataDir)
})
