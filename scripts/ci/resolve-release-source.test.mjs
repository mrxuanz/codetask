import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = resolve('scripts/resolve-release-source.mjs')
const requiredFiles = [
  '.github/workflows/build.yml',
  'package-lock.json',
  'scripts/package-server-sea.mjs',
  'scripts/release-evidence.mjs',
  'scripts/run-and-record.mjs'
]

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function run(repo, eventSha, tag, output) {
  return spawnSync(
    process.execPath,
    [
      script,
      '--repo',
      repo,
      '--event',
      'workflow_dispatch',
      '--event-sha',
      eventSha,
      '--tag',
      tag,
      '--output',
      output
    ],
    { encoding: 'utf8' }
  )
}

test('manual releases reject an old tag and accept a new tag at the selected commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'release-source-'))
  try {
    git(repo, 'init')
    git(repo, 'config', 'user.name', 'CI Test')
    git(repo, 'config', 'user.email', 'ci@example.invalid')
    writeFileSync(join(repo, 'old.txt'), 'old\n')
    git(repo, 'add', 'old.txt')
    git(repo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'old release')
    git(repo, 'tag', 'v0.1.0')

    for (const file of requiredFiles) {
      mkdirSync(join(repo, file, '..'), { recursive: true })
      writeFileSync(join(repo, file), `${file}\n`)
    }
    git(repo, 'add', '.')
    git(repo, '-c', 'commit.gpgSign=false', 'commit', '-m', 'release tooling')
    const currentSha = git(repo, 'rev-parse', 'HEAD')

    const oldTag = run(repo, currentSha, 'v0.1.0', join(repo, 'old-output'))
    assert.notEqual(oldTag.status, 0)
    assert.match(oldTag.stderr, /release_source\.tag_commit_mismatch/u)

    const output = join(repo, 'new-output')
    const newTag = run(repo, currentSha, 'v0.2.0-beta.1', output)
    assert.equal(newTag.status, 0, newTag.stderr)
    assert.match(readFileSync(output, 'utf8'), new RegExp(`sha=${currentSha}`, 'u'))
    assert.match(readFileSync(output, 'utf8'), /tag-exists=false/u)

    git(repo, 'tag', 'v0.2.0-beta.1')
    const existingTag = run(repo, currentSha, 'v0.2.0-beta.1', join(repo, 'existing-output'))
    assert.equal(existingTag.status, 0, existingTag.stderr)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
