import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import {
  bootstrapRuntime,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import {
  assertWorkspacePathAllowed,
  resetAllowedWorkspaceRootsCacheForTests
} from '../../src/server/fs/allowed-workspace-roots'
import { AppError } from '../../src/server/error'

test('assertWorkspacePathAllowed enforces server roots', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-allowed-roots-'))
  const allowedRoot = mkdtempSync(join(tmpdir(), 'codetask-allowed-root-'))
  const workspace = join(allowedRoot, 'proj')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), 'ok')

  const outside = mkdtempSync(join(tmpdir(), 'codetask-outside-root-'))
  process.env.CODETASK_MODE = 'server'
  process.env.CODETASK_ALLOWED_WORKSPACE_ROOTS = allowedRoot

  bootstrapRuntime({ dataDir, mode: 'server' })
  resetAllowedWorkspaceRootsCacheForTests()

  t.after(async () => {
    delete process.env.CODETASK_MODE
    delete process.env.CODETASK_ALLOWED_WORKSPACE_ROOTS
    resetAllowedWorkspaceRootsCacheForTests()
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(allowedRoot, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  assert.doesNotThrow(() => assertWorkspacePathAllowed(workspace))
  assert.throws(() => assertWorkspacePathAllowed(outside), (error: unknown) => {
    return error instanceof AppError && error.httpStatus === 403
  })
})
