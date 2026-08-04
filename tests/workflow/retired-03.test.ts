/**
 * Legacy workflow suite retired in architecture 03.
 * create_task / wizard /threads job paths are gone.
 * Coverage lives in:
 * - tests/conversation/* (pure Chat)
 * - tests/design/* (Draft → Planning → Publish)
 * - tests/execution/* (Job runtime)
 * - tests/architecture/dod-03.test.ts (isolation DoD)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('workflow suite retirement (03)', () => {
  it('legacy create_task workflow files are removed', () => {
    for (const name of [
      '01-entry-thread.test.ts',
      '02-conversation-draft-plan.test.ts',
      '03-execution-happy-path.test.ts',
      '04-repair-inconclusive.test.ts',
      '05-references.test.ts',
      '06-controls-recovery.test.ts',
      '07-failures.test.ts',
      '08-permissions-locking.test.ts'
    ]) {
      assert.equal(existsSync(join(root, 'tests/workflow', name)), false, name)
    }
  })

  it('replacement suites exist', () => {
    assert.equal(existsSync(join(root, 'tests/conversation/conversation-module-03.test.ts')), true)
    assert.equal(existsSync(join(root, 'tests/design/design-module.test.ts')), true)
    assert.equal(
      existsSync(join(root, 'tests/execution/design-publish-to-execution.test.ts')),
      true
    )
    assert.equal(existsSync(join(root, 'tests/architecture/dod-03.test.ts')), true)
  })
})
