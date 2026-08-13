import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = resolve('scripts/release-evidence.mjs')
const commit = '0123456789abcdef0123456789abcdef01234567'
const platforms = [
  'linux-arm64',
  'linux-amd64',
  'macos-arm64',
  'macos-amd64',
  'windows-arm64',
  'windows-amd64'
]

function run(
  args: string[],
  cwd = resolve('.'),
  env: NodeJS.ProcessEnv = process.env
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env })
}

test('release evidence verifies the same commit, logs, lockfile, platforms and artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-evidence-'))
  try {
    const toolchainBin = join(root, 'toolchain-bin')
    mkdirSync(toolchainBin)
    const rustcShim = join(toolchainBin, process.platform === 'win32' ? 'rustc.cmd' : 'rustc')
    writeFileSync(
      rustcShim,
      process.platform === 'win32'
        ? '@echo off\r\necho rustc 1.90.0 (release-evidence test)\r\n'
        : "#!/bin/sh\nprintf '%s\\n' 'rustc 1.90.0 (release-evidence test)'\n"
    )
    if (process.platform !== 'win32') chmodSync(rustcShim, 0o755)
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const testEnv = {
      ...process.env,
      [pathKey]: `${toolchainBin}${delimiter}${process.env[pathKey] ?? ''}`
    }
    const runWithToolchain = (args: string[]): ReturnType<typeof spawnSync> =>
      run(args, resolve('.'), testEnv)

    const lockfile = join(root, 'package-lock.json')
    const testLog = join(root, 'test-gate.log')
    const smokeLog = join(root, 'package-smoke.log')
    const seaSmokeLog = join(root, 'server-sea-smoke.log')
    const buildLog = join(root, 'build.log')
    const nativeTestLog = join(root, 'native-test.log')
    writeFileSync(lockfile, '{"lockfileVersion":3}\n')
    writeFileSync(testLog, 'all release tests passed\n')
    writeFileSync(smokeLog, '{"ok":true,"health":{"health":"ok"}}\n')
    writeFileSync(seaSmokeLog, '{"ok":true,"mode":"sea","health":{"health":"ok"}}\n')
    writeFileSync(buildLog, 'build passed\n')
    writeFileSync(nativeTestLog, '[run-and-record] exitCode=0 signal=none\n')
    for (const platform of platforms) {
      const extension = platform.startsWith('linux-')
        ? 'AppImage'
        : platform.startsWith('macos-')
          ? 'dmg'
          : 'exe'
      writeFileSync(
        join(root, `codetask-0.1.0-${platform}.${extension}`),
        `${platform} application artifact`
      )
      if (platform.startsWith('linux-')) {
        writeFileSync(
          join(root, `codetask-server-0.1.0-${platform}.tar.gz`),
          `${platform} sea service artifact`
        )
      }
    }

    const testOutput = join(root, 'release-evidence', 'test', 'test-gate.manifest.json')
    const testResult = runWithToolchain([
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

    for (const platform of platforms) {
      const outputDir = join(root, 'release-evidence', platform)
      mkdirSync(outputDir, { recursive: true })
      const signatureLog = join(outputDir, 'signature-verification.log')
      writeFileSync(
        signatureLog,
        `${JSON.stringify({
          ok: true,
          platform,
          signing: platform.startsWith('linux-') ? 'not-required' : 'verified'
        })}\n`
      )
      const result = runWithToolchain([
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
        smokeLog,
        '--log',
        seaSmokeLog,
        '--log',
        nativeTestLog,
        '--log',
        signatureLog
      ])
      assert.equal(result.status, 0, result.stderr)
    }

    const report = join(root, 'legacy-release-report.json')
    const verified = runWithToolchain([
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
    assert.equal(parsed.manifests.length, 7)

    writeFileSync(join(root, 'codetask-0.1.0-linux-amd64.AppImage'), 'tampered artifact')
    const rejected = runWithToolchain([
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
