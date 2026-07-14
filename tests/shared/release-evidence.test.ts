import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = resolve('scripts/release-evidence.mjs')
const commit = '0123456789abcdef0123456789abcdef01234567'

function run(args: string[], cwd = resolve('.')): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
}

test('release evidence verifies the same commit, logs, lockfile, platforms and artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-evidence-'))
  try {
    const lockfile = join(root, 'package-lock.json')
    const testLog = join(root, 'test-gate.log')
    const smokeLog = join(root, 'package-smoke.log')
    const buildLog = join(root, 'build.log')
    writeFileSync(lockfile, '{"lockfileVersion":3}\n')
    writeFileSync(testLog, 'all release tests passed\n')
    writeFileSync(smokeLog, '{"ok":true,"health":{"health":"ok"}}\n')
    writeFileSync(buildLog, 'build passed\n')
    writeFileSync(join(root, 'codetask-0.1.0-linux-x64.AppImage'), 'linux application artifact')
    writeFileSync(join(root, 'codetask-0.1.0-macos-arm64.dmg'), 'macos application artifact')
    writeFileSync(join(root, 'codetask-0.1.0-windows-x64.exe'), 'windows application artifact')

    const testOutput = join(root, 'release-evidence', 'test', 'test-gate.manifest.json')
    const testResult = run([
      'create-test',
      '--commit',
      commit,
      '--lockfile',
      lockfile,
      '--evidence-root',
      root,
      '--out',
      testOutput,
      '--log',
      testLog
    ])
    assert.equal(testResult.status, 0, testResult.stderr)

    for (const platform of ['linux-x64', 'macos-arm64', 'windows-x64']) {
      const outputDir = join(root, 'release-evidence', platform)
      mkdirSync(outputDir, { recursive: true })
      const result = run([
        'create-build',
        '--commit',
        commit,
        '--platform',
        platform,
        '--dist',
        root,
        '--lockfile',
        lockfile,
        '--evidence-root',
        root,
        '--out',
        join(outputDir, 'build.manifest.json'),
        '--log',
        buildLog,
        '--log',
        smokeLog
      ])
      assert.equal(result.status, 0, result.stderr)
    }

    const report = join(root, 'legacy-release-report.json')
    const verified = run([
      'verify',
      '--root',
      root,
      '--commit',
      commit,
      '--lockfile',
      lockfile,
      '--report',
      report
    ])
    assert.equal(verified.status, 0, verified.stderr)
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as {
      kind: string
      status: string
      manifests: unknown[]
    }
    assert.equal(parsed.kind, 'legacy-release-report')
    assert.equal(parsed.status, 'passed')
    assert.equal(parsed.manifests.length, 4)

    writeFileSync(join(root, 'codetask-0.1.0-linux-x64.AppImage'), 'tampered artifact')
    const rejected = run([
      'verify',
      '--root',
      root,
      '--commit',
      commit,
      '--lockfile',
      lockfile,
      '--report',
      join(root, 'tampered-report.json')
    ])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /artifact_hash_mismatch/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
