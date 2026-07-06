import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClaudeSettingSources } from '../../src/server/agent-runtime/providers/claude-policy'

test('resolveClaudeSettingSources clears sources in outer sandbox', () => {
  assert.deepEqual(resolveClaudeSettingSources(true), [])
  assert.deepEqual(resolveClaudeSettingSources(false), ['user', 'project', 'local'])
})
