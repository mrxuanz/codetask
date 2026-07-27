import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { JobError, parseWorkResult } from '../../src/server/core/domain/job'
import {
  captureDeclaredWorkspaceState,
  recoverEmptyWorkReply
} from '../../src/server/composition/job/workspace-change-evidence'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'codetask-work-evidence-'))
  roots.push(root)
  return root
}

describe('empty Work result recovery', () => {
  it('turns an empty provider reply into a server-observed result when a declared file changed', () => {
    const root = workspace()
    const before = captureDeclaredWorkspaceState(root, ['README.md'])
    writeFileSync(join(root, 'README.md'), '# Verified\n', 'utf8')
    const after = captureDeclaredWorkspaceState(root, ['README.md'])

    const result = parseWorkResult(recoverEmptyWorkReply('', before, after))

    assert.equal(result.status, 'completed')
    assert.deepEqual(result.changedFiles, ['README.md'])
    assert.match(result.summary, /server observed changes/i)
    assert.deepEqual(result.evidence, ['server-observed workspace change: README.md'])
  })

  it('keeps failing closed when an empty reply produced no declared workspace change', () => {
    const root = workspace()
    writeFileSync(join(root, 'README.md'), '# Existing\n', 'utf8')
    const before = captureDeclaredWorkspaceState(root, ['README.md'])
    const after = captureDeclaredWorkspaceState(root, ['README.md'])

    assert.throws(
      () => recoverEmptyWorkReply('', before, after),
      (error: unknown) => error instanceof JobError && error.code === 'job.empty_result'
    )
  })

  it('does not treat changes outside the declared file set as completion evidence', () => {
    const root = workspace()
    mkdirSync(join(root, 'src'))
    const before = captureDeclaredWorkspaceState(root, ['README.md'])
    writeFileSync(join(root, 'src', 'unexpected.ts'), 'export {}\n', 'utf8')
    const after = captureDeclaredWorkspaceState(root, ['README.md'])

    assert.throws(
      () => recoverEmptyWorkReply('', before, after),
      (error: unknown) => error instanceof JobError && error.code === 'job.empty_result'
    )
  })

  it('preserves a non-empty provider result unchanged', () => {
    const root = workspace()
    const state = captureDeclaredWorkspaceState(root, ['README.md'])
    const reply =
      '{"status":"completed","summary":"ok","changedFiles":[],"evidence":["provider result"]}'

    assert.equal(recoverEmptyWorkReply(reply, state, state), reply)
  })
})
