import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildClaudeTurnOptions,
  resolveClaudeSettingSources,
  resolveClaudeSystemPrompt
} from '../../src/server/providers/claude/turn-options'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('resolveClaudeSettingSources clears only for outer sandbox', () => {
  assert.deepEqual(resolveClaudeSettingSources(true), [])
  assert.deepEqual(resolveClaudeSettingSources(false), ['user', 'project', 'local'])
  // Read-only conversation still loads host settings (auth/model); MCP/skills overridden elsewhere.
  assert.deepEqual(resolveClaudeSettingSources(false, 'chat-read'), ['user', 'project', 'local'])
  assert.deepEqual(resolveClaudeSettingSources(false, 'create-task-read'), [
    'user',
    'project',
    'local'
  ])
  assert.deepEqual(resolveClaudeSettingSources(false, 'planner-read'), ['user', 'project', 'local'])
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

test('Claude direct write uses only the native workspace boundary', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-native-boundary-'))
  try {
    const plan = buildClaudeTurnOptions(
      {
        provider: 'claude-code',
        role: 'conversation',
        cwd: runtimeRoot,
        runtimeRoot,
        prompt: 'edit a file',
        capabilityProfile: 'chat-write'
      },
      { outerSandbox: false }
    )
    assert.equal(plan.outerSandbox, false)
    assert.equal(plan.permissionMode, 'acceptEdits')
    assert.equal(plan.allowDangerouslySkipPermissions, false)
    assert.equal(plan.sandbox.enabled, true)
    assert.equal(plan.sandbox.failIfUnavailable, true)
    assert.equal(plan.sandbox.allowUnsandboxedCommands, false)
    assert.deepEqual(plan.sandbox.filesystem?.allowWrite, [runtimeRoot])

    const readOnly = buildClaudeTurnOptions(
      {
        provider: 'claude-code',
        role: 'planner',
        cwd: runtimeRoot,
        runtimeRoot,
        prompt: 'plan',
        capabilityProfile: 'planner-read'
      },
      { outerSandbox: false }
    )
    assert.equal(readOnly.sandbox.enabled, false)
    assert.equal(readOnly.permissionMode, 'bypassPermissions')
    assert.equal(readOnly.allowDangerouslySkipPermissions, true)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
