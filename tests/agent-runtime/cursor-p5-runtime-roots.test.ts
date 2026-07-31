import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('agent-runtime no longer exports durable CodeTask runtime root helpers', () => {
  const index = readFileSync(join(root, 'src/server/agent-runtime/index.ts'), 'utf8')
  assert.doesNotMatch(index, /ensureConversationRuntimeRoot/)
  assert.doesNotMatch(index, /ensureJobRuntimeRoot/)
  assert.doesNotMatch(index, /ensureJobTaskRuntimeRoot/)
  const runner = readFileSync(join(root, 'src/server/agent-runtime/runner.ts'), 'utf8')
  assert.doesNotMatch(runner, /ensureIsolatedProviderDirs/)
  assert.match(runner, /resolveWorkspaceBinding\(\{\s*workspaceRoot:/)
})
