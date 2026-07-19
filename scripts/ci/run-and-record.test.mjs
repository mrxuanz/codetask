import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { resolveInvocation } from '../run-and-record.mjs'

test('Windows npm recording runs npm CLI through node.exe without a shell', () => {
  const invocation = resolveInvocation(
    'win32',
    'C:\\hostedtoolcache\\node\\24\\x64\\node.exe',
    'npm',
    ['run', 'build:sandbox']
  )
  assert.deepEqual(invocation, {
    command: 'C:\\hostedtoolcache\\node\\24\\x64\\node.exe',
    args: [
      'C:\\hostedtoolcache\\node\\24\\x64\\node_modules\\npm\\bin\\npm-cli.js',
      'run',
      'build:sandbox'
    ],
    npmCli: true
  })
})

test('run-and-record preserves output and the child exit status', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-and-record-'))
  try {
    const log = join(root, 'command.log')
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/run-and-record.mjs'),
        '--out',
        log,
        '--',
        process.execPath,
        '-e',
        'console.log("recorded-output")'
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /recorded-output/u)
    assert.match(readFileSync(log, 'utf8'), /recorded-output/u)
    assert.match(readFileSync(log, 'utf8'), /exitCode=0 signal=none/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
