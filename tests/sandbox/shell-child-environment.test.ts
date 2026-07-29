import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  configureShellChildEnvironment,
  resetShellChildEnvironment
} from '../../src/server/shell-child-environment.ts'
import { buildSandboxEnv } from '../../src/server/sandbox/env.ts'

test('sandbox core consumes only the shell-provided child environment overlay', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-shell-child-env-'))
  t.after(() => {
    resetShellChildEnvironment()
    rmSync(runtimeRoot, { recursive: true, force: true })
  })

  configureShellChildEnvironment({})
  assert.equal(buildSandboxEnv({ runtimeRoot }).ELECTRON_RUN_AS_NODE, undefined)

  configureShellChildEnvironment({ ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(buildSandboxEnv({ runtimeRoot }).ELECTRON_RUN_AS_NODE, '1')
})
