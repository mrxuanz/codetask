import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { describe as nodeDescribe, it, before, beforeEach, afterEach } from 'node:test'
import {
  assertFails,
  assertEscapeBlocked,
  assertSucceeds,
  createSandboxFixture,
  debugAttachAvailable,
  dockerSocketWriteCommand,
  killHostFromSandboxCommand,
  killOwnChildInSandboxCommand,
  loadNative,
  outsideWriteProbePath,
  platformRuntimeReadCommand,
  policyForRoleV2,
  ptraceHostCommand,
  runInSandbox,
  sandboxTestsEnabled,
  shellQuote,
  spawnHostSentinel,
  symlinkEscapeWriteCommand
} from './sandbox-test-utils.mjs'

const gate = sandboxTestsEnabled()
const describe = gate.enabled ? nodeDescribe : nodeDescribe.skip

function writeCmd(target, content = 'hacked') {
  const q = shellQuote(target)
  return process.platform === 'win32' ? `echo ${content}> ${q}` : `echo ${content} > ${q}`
}

function readCmd(target) {
  const q = shellQuote(target)
  return process.platform === 'win32' ? `type ${q}` : `cat ${q}`
}

describe('role matrix: filesystem permissions', () => {
  let native
  let fixture

  before(() => {
    native = loadNative()
    native.preflight()
  })

  beforeEach(() => {
    fixture = createSandboxFixture('codeteam-escape-')
  })

  afterEach(() => {
    fixture?.cleanup()
  })

  it('planner can read workspace but cannot write workspace', async () => {
    const probe = join(fixture.workspace, 'probe.txt')
    writeFileSync(probe, 'readable')

    const policy = policyForRoleV2('planner', fixture.workspace, fixture.runtime)
    await assertSucceeds(runInSandbox(native, policy, readCmd(probe)), 'planner can read workspace')
    await assertFails(
      runInSandbox(native, policy, writeCmd(probe)),
      'planner cannot write workspace'
    )
  })

  it('task-worker can write workspace and runtime', async () => {
    const probe = join(fixture.workspace, 'task-probe.txt')
    const runtimeProbe = join(fixture.runtime, 'runtime-probe.txt')
    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)

    await assertSucceeds(
      runInSandbox(native, policy, writeCmd(probe, 'ok')),
      'task-worker can write workspace'
    )
    await assertSucceeds(
      runInSandbox(native, policy, writeCmd(runtimeProbe, 'ok')),
      'task-worker can write runtime'
    )
    assert.equal(readFileSync(probe, 'utf8').trim(), 'ok')
  })

  it('slice-verifier cannot write workspace but can write verifier output root', async () => {
    const probe = join(fixture.workspace, 'verifier-probe.txt')
    const outProbe = join(fixture.verifierOutput, 'report.txt')
    const policy = policyForRoleV2('slice-verifier', fixture.workspace, fixture.runtime, {
      verifierOutputRoot: fixture.verifierOutput
    })

    await assertFails(
      runInSandbox(native, policy, writeCmd(probe)),
      'slice-verifier cannot write workspace'
    )
    await assertSucceeds(
      runInSandbox(native, policy, writeCmd(outProbe, 'report')),
      'slice-verifier can write verifier output'
    )
  })

  it('milestone-verifier cannot modify workspace files', async () => {
    const probe = join(fixture.workspace, 'milestone-probe.txt')
    writeFileSync(probe, 'original')
    const policy = policyForRoleV2('milestone-verifier', fixture.workspace, fixture.runtime)

    await assertFails(
      runInSandbox(native, policy, writeCmd(probe)),
      'milestone-verifier cannot write workspace'
    )
    assert.equal(readFileSync(probe, 'utf8'), 'original')
  })

  it('task-worker cannot write outside allowed roots', async () => {
    const outside = outsideWriteProbePath()
    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)

    await assertFails(
      runInSandbox(native, policy, writeCmd(outside)),
      'task-worker cannot write outside roots'
    )
  })

  it('task-worker cannot write protected .codeteam directory', async () => {
    const secretDir = join(fixture.workspace, '.codeteam')
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(join(secretDir, 'secret.txt'), 'protected')
    const secret = join(secretDir, 'secret.txt')
    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)

    await assertFails(
      runInSandbox(native, policy, writeCmd(secret)),
      'task-worker cannot write .codeteam'
    )
    assert.equal(readFileSync(secret, 'utf8'), 'protected')
  })

  it('roles can read platform runtime paths (hosts file)', async () => {
    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertSucceeds(
      runInSandbox(native, policy, platformRuntimeReadCommand()),
      'task-worker can read platform runtime path'
    )
  })
})

describe('escape prevention: host process isolation', () => {
  let native

  before(() => {
    native = loadNative()
    native.preflight()
  })

  it('sandbox cannot kill host sentinel process', async (t) => {
    const sentinel = spawnHostSentinel()
    t.after(() => sentinel.cleanup())
    assert.ok(sentinel.isAlive(), 'host sentinel failed to start')

    const fixture = createSandboxFixture('codeteam-sentinel-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertFails(
      runInSandbox(native, policy, killHostFromSandboxCommand(sentinel.pid)),
      'task-worker cannot kill host sentinel'
    )
    assert.ok(sentinel.isAlive(), 'host sentinel was killed — sandbox escape')
  })

  it('sandbox cannot ptrace or terminate host via debug APIs', async (t) => {
    if (!debugAttachAvailable()) {
      t.skip('gdb/lldb not installed on this host')
      return
    }

    const sentinel = spawnHostSentinel()
    t.after(() => sentinel.cleanup())

    const fixture = createSandboxFixture('codeteam-ptrace-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    const result = await runInSandbox(native, policy, ptraceHostCommand(sentinel.pid))
    assert.notEqual(result.code, 0, 'ptrace/debug attach should fail inside sandbox')
    assert.ok(sentinel.isAlive(), 'host sentinel died during ptrace test')
  })

  it('sandbox can signal its own child process', async (t) => {
    const fixture = createSandboxFixture('codeteam-own-child-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertSucceeds(
      runInSandbox(native, policy, killOwnChildInSandboxCommand()),
      'task-worker can kill own sandbox child'
    )
  })
})

describe('escape prevention: symlink and privileged IPC', () => {
  let native

  before(() => {
    native = loadNative()
    native.preflight()
  })

  it('cannot write host file through symlink escape', async (t) => {
    if (process.platform === 'win32') {
      t.skip('mklink requires elevated token; covered by Windows ACL matrix separately')
      return
    }

    const fixture = createSandboxFixture('codeteam-symlink-')
    t.after(() => fixture.cleanup())

    const outside = join(tmpdir(), `codeteam-outside-${Date.now()}.txt`)
    writeFileSync(outside, 'original')
    t.after(() => {
      try {
        rmSync(outside, { force: true })
      } catch {
        // best-effort cleanup
      }
    })
    const linkPath = join(fixture.workspace, 'escape-link')
    symlinkSync(outside, linkPath)

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertEscapeBlocked(
      runInSandbox(native, policy, writeCmd(linkPath)),
      'task-worker cannot write through symlink to outside file',
      () => assert.equal(readFileSync(outside, 'utf8'), 'original')
    )
  })

  it('cannot create symlink pointing outside and overwrite target', async (t) => {
    if (process.platform === 'win32') {
      t.skip('mklink creation restricted on Windows sandbox account')
      return
    }

    const fixture = createSandboxFixture('codeteam-symlink-create-')
    t.after(() => fixture.cleanup())

    const outside = join(tmpdir(), `codeteam-outside-create-${Date.now()}.txt`)
    writeFileSync(outside, 'original')
    t.after(() => {
      try {
        rmSync(outside, { force: true })
      } catch {
        // best-effort cleanup
      }
    })

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertEscapeBlocked(
      runInSandbox(native, policy, symlinkEscapeWriteCommand(fixture.workspace, outside)),
      'task-worker cannot symlink-escape write',
      () => assert.equal(readFileSync(outside, 'utf8'), 'original')
    )
  })

  it('cannot write docker engine socket or named pipe', async (t) => {
    if (process.platform === 'linux' && !existsSync('/var/run/docker.sock')) {
      t.skip('docker.sock not present on this host')
      return
    }

    const fixture = createSandboxFixture('codeteam-docker-')
    t.after(() => fixture.cleanup())

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime)
    await assertFails(
      runInSandbox(native, policy, dockerSocketWriteCommand()),
      'task-worker cannot write docker IPC endpoint'
    )
  })
})

describe('attachment readRoots remain read-only inside sandbox', () => {
  it('task-worker reads attachment dir but cannot mutate it', async (t) => {
    const native = loadNative()
    native.preflight()

    const fixture = createSandboxFixture('codeteam-attach-')
    t.after(() => fixture.cleanup())

    const attachmentsRoot = join(fixture.base, 'blobs', 'attachments', 'thread-1')
    mkdirSync(attachmentsRoot, { recursive: true })
    const heroPath = join(attachmentsRoot, 'att-hero.png')
    const copiedPath = join(fixture.workspace, 'from-attachment.png')
    writeFileSync(heroPath, 'hero-bytes')

    const policy = policyForRoleV2('task-worker', fixture.workspace, fixture.runtime, {
      extraReadRoots: [realpathSync(attachmentsRoot)]
    })

    const copyCmd =
      process.platform === 'win32'
        ? `copy /Y ${shellQuote(heroPath)} ${shellQuote(copiedPath)}`
        : `cp ${shellQuote(heroPath)} ${shellQuote(copiedPath)}`

    await assertSucceeds(
      runInSandbox(native, policy, copyCmd),
      'task-worker can read attachment into workspace'
    )
    assert.equal(readFileSync(copiedPath, 'utf8'), 'hero-bytes')

    await assertFails(
      runInSandbox(native, policy, writeCmd(heroPath)),
      'task-worker cannot write attachment directory'
    )
    assert.equal(readFileSync(heroPath, 'utf8'), 'hero-bytes')
  })
})

if (!gate.enabled) {
  test('escape matrix integration skipped', { skip: false }, (t) => {
    t.diagnostic(gate.reason)
  })
}
