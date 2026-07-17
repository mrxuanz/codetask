import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveClaudeSettingSources,
  resolveClaudeSystemPrompt
} from '../../src/server/agent-runtime/providers/claude-policy'

test('resolveClaudeSettingSources clears sources in outer sandbox', () => {
  assert.deepEqual(resolveClaudeSettingSources(true), [])
  assert.deepEqual(resolveClaudeSettingSources(false), ['user', 'project', 'local'])
  assert.deepEqual(resolveClaudeSettingSources(false, 'chat-read'), [])
  assert.deepEqual(resolveClaudeSettingSources(false, 'create-task-read'), [])
  assert.deepEqual(resolveClaudeSettingSources(false, 'planner-read'), [])
  assert.deepEqual(resolveClaudeSettingSources(false, 'chat-write'), ['user', 'project', 'local'])
})

test('resolveClaudeSystemPrompt always uses claude_code preset', () => {
  assert.deepEqual(resolveClaudeSystemPrompt(undefined), {
    type: 'preset',
    preset: 'claude_code'
  })
  assert.deepEqual(resolveClaudeSystemPrompt(''), {
    type: 'preset',
    preset: 'claude_code'
  })
  assert.deepEqual(resolveClaudeSystemPrompt('  You are a planner.  '), {
    type: 'preset',
    preset: 'claude_code',
    append: 'You are a planner.'
  })
})
