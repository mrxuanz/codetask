import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = join(REPO_ROOT, 'scripts/cutover/delete-legacy.mjs')

function run(args: string[] = []): {
  status: number
  stdout: string
  stderr: string
} {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

describe('delete-legacy gate (Phase D)', () => {
  it('gate is clear (zero external importers, exit 0)', () => {
    const { status, stdout, stderr } = run()
    const combined = `${stdout}\n${stderr}`
    assert.equal(status, 0, `expected exit 0, got ${status}: ${combined}`)
    assert.match(combined, /Gate clear/i)
    assert.match(combined, /zero importers/i)
  })

  it('--force-dry-run prints candidates when gate is clear', () => {
    const { status, stdout, stderr } = run(['--force-dry-run'])
    const combined = `${stdout}\n${stderr}`
    assert.equal(status, 0, `expected exit 0, got ${status}: ${combined}`)
    assert.match(combined, /force-dry-run/i)
    assert.match(combined, /src\/server\/http\/v3/)
    assert.match(combined, /Gate clear/i)
  })

  it('--json reports blocked:false with zero totals', () => {
    const { status, stdout, stderr } = run(['--json'])
    assert.equal(status, 0, `expected exit 0: ${stdout}\n${stderr}`)
    const start = stdout.indexOf('{')
    const end = stdout.lastIndexOf('}')
    assert.ok(start >= 0 && end > start, `expected JSON object in stdout, got: ${stdout}\n${stderr}`)
    const payload = JSON.parse(stdout.slice(start, end + 1)) as {
      blocked: boolean
      total: number
      rows: { needle: string; count: number }[]
    }
    assert.equal(payload.blocked, false)
    assert.equal(payload.total, 0)
    for (const row of payload.rows) {
      assert.equal(row.count, 0, `${row.needle} should be zero`)
    }
    const needles = new Set(payload.rows.map((r) => r.needle))
    assert.ok(needles.has('legacy-control-plane'))
    assert.ok(needles.has('http/v3'))
    assert.ok(needles.has('v3_authoritative'))
  })
})
