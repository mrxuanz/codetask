import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findAttachmentPermissionRefusal,
  findImageInputUnsupported
} from './drivers/attachment-permission'

test('detects an OpenCode external attachment permission refusal', () => {
  const refusal = findAttachmentPermissionRefusal({
    messages: [
      { role: 'user', content: '请读取附件' },
      {
        role: 'assistant',
        content:
          'I cannot read the image content — the file path is outside the allowed directory permissions.'
      }
    ]
  })

  assert.match(refusal ?? '', /outside the allowed directory permissions/u)
})

test('does not mistake a successful image response for a permission refusal', () => {
  assert.equal(
    findAttachmentPermissionRefusal([
      { role: 'assistant', content: 'The image reads: Dream of 1000 Cats' }
    ]),
    null
  )
})

test('detects provider models without image input support', () => {
  assert.match(
    findImageInputUnsupported([
      {
        role: 'assistant',
        content: '抱歉，我无法读取图片内容，因为当前模型不支持图像输入。'
      }
    ]) ?? '',
    /当前模型不支持图像输入/u
  )
  assert.equal(
    findImageInputUnsupported([
      { role: 'assistant', content: 'The image reads: Dream of 1000 Cats' }
    ]),
    null
  )
})
