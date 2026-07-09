import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { join } from 'node:path'

const executorPath = join(process.cwd(), 'src/server/jobs/executor.ts')
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
})
