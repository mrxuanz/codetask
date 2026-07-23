import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProcessHostEnvironmentSource,
  resolveHostEnvironment,
  type HostEnvironmentCommandRunner
} from '../../src/server/host-environment.ts'

const START = '__CODETASK_HOST_ENV_START__'
const END = '__CODETASK_HOST_ENV_END__'

function capturedJson(env: Record<string, string>): string {
  return `shell startup noise\n${START}${JSON.stringify(env)}${END}\n`
}

function capturedNull(env: Record<string, string>): string {
  return `shell startup noise\0${START}\0${Object.entries(env)
    .map(([key, value]) => `${key}=${value}\0`)
    .join('')}${END}\0`
}

test('POSIX host resolution imports arbitrary shell-managed state without manager rules', async () => {
  const calls: Array<{
    command: string
    args: readonly string[]
    env: NodeJS.ProcessEnv
  }> = []
  const runCommand: HostEnvironmentCommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options.env })
    return capturedNull({
      PATH: '/future-manager/shims:/usr/bin',
      FNNM_FUTURE_STATE: '/future-manager/state',
      OPENAI_API_KEY: 'shell-value',
      ELECTRON_RUN_AS_NODE: '1'
    })
  }

  const env = await resolveHostEnvironment({
    env: {
      PATH: '/app/bin:/usr/bin',
      OPENAI_API_KEY: 'inherited-value'
    },
    platform: 'linux',
    userShell: '/bin/future-shell',
    runCommand
  })

  assert.equal(calls[0]?.command, '/bin/future-shell')
  assert.deepEqual(calls[0]?.args.slice(0, 1), ['-ilc'])
  assert.match(calls[0]?.args[1] ?? '', /command env -0/)
  assert.equal(calls[0]?.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.PATH, '/future-manager/shims:/usr/bin:/app/bin')
  assert.equal(env.FNNM_FUTURE_STATE, '/future-manager/state')
  assert.equal(env.OPENAI_API_KEY, 'inherited-value')
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
})

test('host resolution falls back to the inherited environment when shell probes fail', async () => {
  const env = await resolveHostEnvironment({
    env: { PATH: '/inherited/bin', HOST_ONLY: 'yes' },
    platform: 'darwin',
    userShell: '/bin/missing-shell',
    runCommand: async () => {
      throw new Error('probe failed')
    }
  })

  assert.deepEqual(env, { PATH: '/inherited/bin', HOST_ONLY: 'yes' })
})

test('Windows host resolution loads a generic profile environment and normalizes PATH casing', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const runCommand: HostEnvironmentCommandRunner = async (command, args) => {
    calls.push({ command, args })
    return capturedJson({
      Path: 'C:\\FutureManager\\shims;C:\\Windows\\System32',
      FNNM_FUTURE_STATE: 'C:\\FutureManager\\state'
    })
  }

  const env = await resolveHostEnvironment({
    env: {
      PATH: 'C:\\App\\bin;C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\tester'
    },
    platform: 'win32',
    runCommand
  })

  assert.equal(calls[0]?.command, 'pwsh.exe')
  assert.equal(calls[0]?.args.includes('-NoProfile'), false)
  assert.equal(env.PATH, 'C:\\FutureManager\\shims;C:\\Windows\\System32;C:\\App\\bin')
  assert.equal(env.FNNM_FUTURE_STATE, 'C:\\FutureManager\\state')
  assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === 'path').length, 1)
})

test('installed host snapshots remain isolated from later caller mutations', () => {
  const source = new ProcessHostEnvironmentSource()
  const input = { PATH: '/captured/bin' }
  source.install(input)
  input.PATH = '/mutated/bin'
  assert.equal(source.snapshot().PATH, '/captured/bin')
})
