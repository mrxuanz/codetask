import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { join } from 'node:path'

const executorPath = join(process.cwd(), 'src/server/legacy-control-plane/executor.ts')
const source = readFileSync(executorPath, 'utf8')

describe('runExecutionLoop step extraction', () => {
  it('keeps a thin scheduler loop that delegates to step helpers', () => {
    assert.match(source, /async function processSliceVerificationStep\(/)
    assert.match(source, /async function processMilestoneVerificationStep\(/)
    assert.match(source, /async function processNextTaskStep\(/)

    const loopStart = source.indexOf('async function runExecutionLoop(')
    const loopEnd = source.indexOf('export function scheduleJobExecution', loopStart)
    assert.ok(loopStart >= 0 && loopEnd > loopStart)
    const loop = source.slice(loopStart, loopEnd)

    assert.match(loop, /processSliceVerificationStep\(ctx\)/)
    assert.match(loop, /processMilestoneVerificationStep\(ctx\)/)
    assert.match(loop, /processNextTaskStep\(ctx\)/)

    // Scheduler should stay small; heavy branches live in step helpers.
    const loopLines = loop.split('\n').length
    assert.ok(loopLines < 80, `expected thin loop, got ${loopLines} lines`)
  })

  it('bounds unchanged-state loops and reopens missing slice verdicts', () => {
    assert.match(source, /MAX_STAGNANT_EXECUTION_ITERATIONS/)
    assert.match(source, /failStagnantExecution\(ctx\)/)
    assert.match(source, /rawVerification\.ok && !rawVerification\.verdict/)
    assert.match(source, /reopenSliceVerificationForMissingVerdict/)
  })

  it('closes the durable attempt when a task pauses for human input', () => {
    const pausedStart = source.indexOf("if (result.kind === 'paused')")
    const interruptedStart = source.indexOf("if (result.kind === 'interrupted')", pausedStart)
    assert.ok(pausedStart >= 0 && interruptedStart > pausedStart)
    const pausedBranch = source.slice(pausedStart, interruptedStart)

    assert.match(pausedBranch, /markTaskAttemptFailed\(\{/)
    assert.match(pausedBranch, /errorJson: JSON\.stringify\(result\.lastError\)/)
  })
})
