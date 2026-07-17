import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildChatConversationBody,
  buildConversationSystemPrompt,
  buildCreateTaskConversationBody
} from '../../src/server/conversation/prompts'
import { buildWorkspaceSnapshot } from '../../src/server/conversation/workspace-snapshot'

test('buildChatConversationBody is a lightweight coding assistant without task workflow', () => {
  const body = buildChatConversationBody('Test Agent')
  assert.match(body, /coding assistant/)
  assert.match(body, /read and edit files/)
  assert.doesNotMatch(body, /propose_task_draft/)
  assert.doesNotMatch(body, /Discussion Workflow/)
  assert.doesNotMatch(body, /coordination assistant/)
  assert.doesNotMatch(body, /Create Task/)
  assert.doesNotMatch(body, /not a coding worker/)
  assert.match(body, /do not mention REQUIREMENTS CONTRACT/)
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
  assert.match(prompt, /coding assistant/)
  assert.doesNotMatch(prompt, /Create Task/)
})

test('buildConversationSystemPrompt create_task mode includes MCP workflow', () => {
  const prompt = buildConversationSystemPrompt('Agent', {
    mode: 'create_task',
    mcpToolsAvailable: true
  })
  assert.match(prompt, /propose_task_draft/)
})

test('ordinary chat service injects no CodeTask system or permission prompt', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/conversation/service.ts'), 'utf8')
  assert.doesNotMatch(source, /The project workspace is writable for this turn/)
  assert.doesNotMatch(source, /The project workspace is read-only for this turn/)
  assert.match(
    source,
    /const systemPrompt = createTaskMode[\s\S]*?: undefined[\s\S]*?streamAgentTurn/
  )
})

test('draft and Planner required MCP setup fail explicitly', () => {
  const conversation = readFileSync(
    join(process.cwd(), 'src/server/conversation/service.ts'),
    'utf8'
  )
  const planner = readFileSync(join(process.cwd(), 'src/server/design-session/planner.ts'), 'utf8')
  assert.match(conversation, /conversation\.mcp_unavailable/)
  assert.match(planner, /plan\.mcp_unavailable/)
  assert.doesNotMatch(conversation, /catch\s*\{\s*mcpUrl = undefined/)
  assert.doesNotMatch(planner, /catch\s*\{\s*mcpUrl = undefined/)
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
