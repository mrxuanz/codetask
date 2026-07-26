import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertNotForgingCompleted,
  canForgeJobCompleted,
  completeVerification,
  decideJobCompletion,
  remapVerdict,
  startVerification,
  type VerificationResult
} from '../../../src/server/core/domain/verification/index.ts'

const passResult: VerificationResult = {
  verdict: 'pass',
  summary: 'ok',
  evidenceRefs: ['e1'],
  findings: []
}

const failResult: VerificationResult = {
  verdict: 'fail',
  summary: 'broken',
  evidenceRefs: [],
  findings: [{ code: 'x', severity: 'error', message: 'broken' }]
}

const inconclusiveResult: VerificationResult = {
  verdict: 'inconclusive',
  summary: 'unclear',
  evidenceRefs: [],
  findings: []
}

describe('verification attempt transitions', () => {
  it('starts from pending to running', () => {
    const result = startVerification({ status: 'pending' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.nextStatus, 'running')
      assert.equal(result.value.result, null)
    }
  })

  it('rejects start when not pending', () => {
    assert.equal(startVerification({ status: 'running' }).ok, false)
    assert.equal(startVerification({ status: 'completed' }).ok, false)
  })

  it('completes running attempt with structured result', () => {
    const result = completeVerification({ status: 'running' }, passResult)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.nextStatus, 'completed')
      assert.equal(result.value.result?.verdict, 'pass')
    }
  })

  it('allows completing with inconclusive without remapping verdict', () => {
    const result = completeVerification({ status: 'running' }, inconclusiveResult)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.result?.verdict, 'inconclusive')
    }
  })

  it('rejects complete when not running', () => {
    assert.equal(completeVerification({ status: 'pending' }, passResult).ok, false)
    assert.equal(completeVerification({ status: 'completed' }, passResult).ok, false)
  })
})

describe('verification cannot forge Completed from inconclusive', () => {
  it('decideJobCompletion maps pass→complete, fail→fail, inconclusive→block', () => {
    assert.deepEqual(decideJobCompletion('pass'), { kind: 'complete' })
    assert.deepEqual(decideJobCompletion('fail'), { kind: 'fail' })
    assert.deepEqual(decideJobCompletion('inconclusive'), { kind: 'block_inconclusive' })
  })

  it('canForgeJobCompleted is true only for pass', () => {
    assert.equal(canForgeJobCompleted('pass'), true)
    assert.equal(canForgeJobCompleted('fail'), false)
    assert.equal(canForgeJobCompleted('inconclusive'), false)
  })

  it('assertNotForgingCompleted rejects inconclusive', () => {
    const forged = assertNotForgingCompleted('inconclusive')
    assert.equal(forged.ok, false)
    if (!forged.ok) {
      assert.equal(forged.error.code, 'verification.inconclusive_not_pass')
    }
  })

  it('assertNotForgingCompleted rejects fail', () => {
    const forged = assertNotForgingCompleted('fail')
    assert.equal(forged.ok, false)
    if (!forged.ok) {
      assert.equal(forged.error.code, 'verification.fail_not_completed')
    }
  })

  it('assertNotForgingCompleted accepts pass', () => {
    const ok = assertNotForgingCompleted('pass')
    assert.equal(ok.ok, true)
  })

  it('remapVerdict forbids inconclusive → pass', () => {
    const remapped = remapVerdict('inconclusive', 'pass')
    assert.equal(remapped.ok, false)
    if (!remapped.ok) {
      assert.equal(remapped.error.code, 'verification.inconclusive_not_pass')
    }
  })

  it('remapVerdict allows identity', () => {
    assert.equal(remapVerdict('inconclusive', 'inconclusive').ok, true)
    assert.equal(remapVerdict('pass', 'pass').ok, true)
  })

  it('mutation guard: treating inconclusive as pass would break decideJobCompletion', () => {
    // Table-driven invariant: only pass yields complete
    const cases: Array<{ verdict: 'pass' | 'fail' | 'inconclusive'; completes: boolean }> = [
      { verdict: 'pass', completes: true },
      { verdict: 'fail', completes: false },
      { verdict: 'inconclusive', completes: false }
    ]
    for (const row of cases) {
      assert.equal(
        decideJobCompletion(row.verdict).kind === 'complete',
        row.completes,
        `verdict=${row.verdict}`
      )
    }
  })
})

describe('verification result shape', () => {
  it('keeps fail and inconclusive distinct from pass', () => {
    assert.notEqual(failResult.verdict, 'pass')
    assert.notEqual(inconclusiveResult.verdict, 'pass')
    assert.equal(passResult.verdict, 'pass')
  })
})
