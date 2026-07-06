import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildChatConversationBody,
  buildConversationSystemPrompt,
  buildCreateTaskConversationBody
} from '../../src/server/conversation/prompts'
import { buildWorkspaceSnapshot } from '../../src/server/conversation/workspace-snapshot'

test('buildChatConversationBody excludes task draft workflow', () => {
  const body = buildChatConversationBody('Test Agent')
  assert.match(body, /coordination assistant/)
  assert.doesNotMatch(body, /propose_task_draft/)
  assert.doesNotMatch(body, /Discussion Workflow/)
  assert.match(body, /do not mention REQUIREMENTS CONTRACT/)
  assert.match(body, /Create Task/)
})

test('buildCreateTaskConversationBody includes draft workflow when MCP is available', () => {
  const body = buildCreateTaskConversationBody('Test Agent', true)
  assert.match(body, /Discussion Workflow/)
  assert.match(body, /propose_task_draft/)
  assert.match(body, /workspace snapshot/)
  assert.match(body, /REQUIREMENTS CONTRACT/)
})

test('buildConversationSystemPrompt uses chat mode by default', () => {
  const prompt = buildConversationSystemPrompt('Agent', { mode: 'chat' })
  assert.doesNotMatch(prompt, /propose_task_draft/)
  assert.match(prompt, /coordination assistant/)
})

test('buildConversationSystemPrompt create_task mode includes MCP workflow', () => {
  const prompt = buildConversationSystemPrompt('Agent', {
    mode: 'create_task',
    mcpToolsAvailable: true
  })
  assert.match(prompt, /propose_task_draft/)
})

test('buildWorkspaceSnapshot lists files and reads package.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-ws-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-app', private: true }, null, 2)
  )
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>demo</title>')
  mkdirSync(join(root, 'src'))

  const snapshot = buildWorkspaceSnapshot(root)
  assert.match(snapshot, /demo-app/)
  assert.match(snapshot, /index\.html/)
  assert.match(snapshot, /src\//)
  assert.match(snapshot, /Workspace snapshot/)
})
