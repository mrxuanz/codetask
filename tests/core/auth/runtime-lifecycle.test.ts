import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../../../src/server/bootstrap'

test('authentication runtimes have independent, explicitly owned lifecycles', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-auth-runtimes-'))
  const firstRoot = join(root, 'first')
  const secondRoot = join(root, 'second')
  mkdirSync(join(firstRoot, 'db'), { recursive: true })
  mkdirSync(join(secondRoot, 'db'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = createRuntime({
    dataDir: firstRoot,
    mode: 'desktop',
    authSecret: '11'.repeat(32)
  })
  const second = createRuntime({
    dataDir: secondRoot,
    mode: 'desktop',
    authSecret: '22'.repeat(32)
  })

  await Promise.all([first.ensureReady(), second.ensureReady()])
  assert.notEqual(first.context, second.context)
  assert.notEqual(first.context.kernelDb, second.context.kernelDb)

  await first.context.security.auth.service.setupAccount({
    username: 'First_Admin',
    password: 'Strong Passw0rd!',
    requestScope: 'first-runtime'
  })
  assert.equal(first.context.security.auth.service.bootstrap().initialized, true)
  assert.equal(second.context.security.auth.service.bootstrap().initialized, false)

  await first.shutdown()
  await assert.rejects(first.ensureReady(), /Runtime is closed/)
  assert.equal(second.context.security.auth.service.bootstrap().initialized, false)

  await second.shutdown()
  await second.shutdown()
})
