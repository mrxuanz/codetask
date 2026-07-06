import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertFails,
  assertSucceeds,
  loadNative,
  policyForRoleV2,
  runInSandbox
} from './sandbox-test-utils.mjs'

async function main() {
  if (process.env.CODETASK_DISABLE_OUTER_SANDBOX === '1') {
    console.log('skip: CODETASK_DISABLE_OUTER_SANDBOX=1')
    return
  }

  const native = loadNative()
  native.preflight()

  const base = mkdtempSync(join(tmpdir(), 'codeteam-sandbox-v2-'))
  const workspace = join(base, 'workspace')
  const runtime = join(base, 'runtime')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(runtime, { recursive: true })

  const plannerPolicy = policyForRoleV2('planner', workspace, runtime)
  const taskPolicy = policyForRoleV2('task-worker', workspace, runtime)

  const probe = join(workspace, 'probe.txt')
  const secret = join(workspace, '.codeteam', 'secret.txt')
  mkdirSync(join(workspace, '.codeteam'), { recursive: true })
  writeFileSync(secret, 'protected')

  const outside =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'codeteam-outside-probe.txt')
      : '/etc/codeteam-outside-probe-v2.txt'

  const readInside = process.platform === 'win32' ? `type "${probe}"` : `cat "${probe}"`
  const readOutside =
    process.platform === 'win32'
      ? `type "${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\drivers\\etc\\hosts"`
      : 'test -r /etc/hosts'

  const cases = [
    [
      'planner cannot write workspace',
      () =>
        assertFails(
          runInSandbox(native, plannerPolicy, `echo hacked > "${probe}"`),
          'planner cannot write workspace'
        )
    ],
    [
      'task-worker can write workspace',
      () =>
        assertSucceeds(
          runInSandbox(native, taskPolicy, `echo ok > "${probe}"`),
          'task-worker can write workspace'
        )
    ],
    [
      'task-worker cannot write outside roots',
      () =>
        assertFails(
          runInSandbox(native, taskPolicy, `echo x > "${outside}"`),
          'task-worker cannot write outside roots'
        )
    ],
    [
      'task-worker cannot write .codeteam',
      () =>
        assertFails(
          runInSandbox(native, taskPolicy, `echo hacked > "${secret}"`),
          'task-worker cannot write .codeteam'
        )
    ],
    [
      'task-worker can read inside workspace',
      () =>
        assertSucceeds(
          runInSandbox(native, taskPolicy, readInside),
          'task-worker can read inside workspace'
        )
    ],
    [
      'task-worker can read platform runtime path',
      () =>
        assertSucceeds(
          runInSandbox(native, taskPolicy, readOutside),
          'task-worker can read platform runtime path'
        )
    ]
  ]

  for (const [, run] of cases) {
    await run()
  }

  if (!existsSync(probe)) {
    throw new Error('probe file missing after successful write test')
  }
  if (readFileSync(probe, 'utf8').trim() !== 'ok') {
    throw new Error('probe file contents unexpected')
  }

  rmSync(base, { recursive: true, force: true })
  console.log(`policy v2 matrix passed on ${process.platform}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
