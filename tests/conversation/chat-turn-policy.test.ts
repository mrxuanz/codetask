import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('chat turn policy source (03)', () => {
  it('chat policy has no create_task path', () => {
    const chat = readFileSync(join(root, 'src/server/conversation/turn-policy/chat.ts'), 'utf8')
    assert.match(chat, /resolveChatAccess/)
    assert.doesNotMatch(chat, /create-task-read|create_task/)
    const index = readFileSync(join(root, 'src/server/conversation/turn-policy/index.ts'), 'utf8')
    assert.match(index, /resolveChatAccess/)
    assert.doesNotMatch(index, /resolveCreateTaskAccess/)
  })
})
