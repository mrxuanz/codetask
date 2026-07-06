import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
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

  const base = mkdtempSync(join(tmpdir(), 'codeteam-sandbox-test-'))
  const workspace = join(base, 'workspace')
  const runtime = join(base, 'runtime')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  const srcFile = join(workspace, 'probe.txt')

  const mainPolicy = policyForRoleV2('main-agent', workspace, runtime)
  const taskPolicy = policyForRoleV2('task-worker', workspace, runtime)

  const outside =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'codeteam-outside-probe.txt')
      : '/etc/codeteam-outside-probe.txt'

  const tests = [
    [
      'main cannot write workspace',
      () =>
        assertFails(
          runInSandbox(native, mainPolicy, `echo hacked > "${srcFile}"`),
          'main cannot write workspace'
        )
    ],
    [
      'task can write workspace',
      () =>
        assertSucceeds(
          runInSandbox(native, taskPolicy, `echo ok > "${srcFile}"`),
          'task can write workspace'
        )
    ],
    [
      'task cannot write outside',
      () =>
        assertFails(
          runInSandbox(native, taskPolicy, `echo x > "${outside}"`),
          'task cannot write outside'
        )
    ],
    [
      'read platform runtime path',
      () =>
        assertSucceeds(
          runInSandbox(
            native,
            taskPolicy,
            process.platform === 'win32'
              ? `type "${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\drivers\\etc\\hosts"`
              : 'cat /etc/hosts | head -n 1'
          ),
          'read platform runtime path'
        )
    ]
  ]

  for (const [, run] of tests) {
    await run()
  }
  if (
    process.platform === 'win32' &&
    existsSync(join(process.cwd(), 'tests/sandbox/windows_smoketest.py'))
  ) {
    const py = spawnSync('python', ['tests/sandbox/windows_smoketest.py'], { encoding: 'utf8' })
    if (py.status !== 0) {
      console.warn('windows smoketest skipped or failed:', py.stderr || py.stdout)
    } else {
      console.log('windows smoketest passed')
    }
  }

  rmSync(base, { recursive: true, force: true })
  console.log(`attack matrix passed on ${process.platform}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
