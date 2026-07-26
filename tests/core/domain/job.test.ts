import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  JobCommandService,
  JobDomainError,
  createJob,
  type Job,
  type JobStatus
} from '../../../src/server/core/domain/jobs/index.ts'

const svc = new JobCommandService()

function job(status: JobStatus, overrides: Partial<Job> = {}): Job {
  return createJob({ id: 'job-1', status, executionGeneration: 3, stateRevision: 10, ...overrides })
}

describe('JobCommandService', () => {
  describe('pause', () => {
    it('queued → paused', () => {
      const next = svc.pause(job('queued'))
      assert.equal(next.status, 'paused')
      assert.equal(next.executionGeneration, 3)
      assert.equal(next.stateRevision, 11)
    })

    it('running → pausing', () => {
      assert.equal(svc.pause(job('running')).status, 'pausing')
    })

    it('repeat pause on paused is idempotent', () => {
      const paused = job('paused')
      const next = svc.pause(paused)
      assert.equal(next, paused)
      assert.equal(next.stateRevision, 10)
    })

    it('repeat pause on pausing is idempotent', () => {
      const pausing = job('pausing')
      assert.equal(svc.pause(pausing), pausing)
    })

    it('illegal from completed / failed / verification / cancelled', () => {
      for (const status of ['completed', 'failed', 'verification', 'cancelled'] as const) {
        assert.throws(() => svc.pause(job(status)), JobDomainError)
      }
    })
  })

  describe('continue', () => {
    it('paused → queued without bumping executionGeneration', () => {
      const next = svc.continue(job('paused'))
      assert.equal(next.status, 'queued')
      assert.equal(next.executionGeneration, 3)
    })

    it('queued is idempotent', () => {
      const queued = job('queued')
      assert.equal(svc.continue(queued), queued)
    })

    it('illegal from running', () => {
      assert.throws(() => svc.continue(job('running')), (err: unknown) => {
        assert.ok(err instanceof JobDomainError)
        assert.equal(err.code, 'job.illegal_transition')
        assert.equal(err.command, 'continue')
        return true
      })
    })
  })

  describe('cancel', () => {
    it('cancels active statuses', () => {
      for (const status of [
        'queued',
        'running',
        'pausing',
        'paused',
        'verification',
        'failed'
      ] as const) {
        assert.equal(svc.cancel(job(status)).status, 'cancelled')
      }
    })

    it('cancelled is idempotent', () => {
      const cancelled = job('cancelled')
      assert.equal(svc.cancel(cancelled), cancelled)
    })

    it('illegal from completed', () => {
      assert.throws(() => svc.cancel(job('completed')), JobDomainError)
    })
  })

  describe('retry', () => {
    it('failed → queued and bumps executionGeneration', () => {
      const next = svc.retry(job('failed'))
      assert.equal(next.status, 'queued')
      assert.equal(next.executionGeneration, 4)
    })

    it('verification → queued (repair) bumps executionGeneration', () => {
      const next = svc.retry(job('verification'))
      assert.equal(next.status, 'queued')
      assert.equal(next.executionGeneration, 4)
    })

    it('queued is idempotent and does not bump generation', () => {
      const queued = job('queued')
      const next = svc.retry(queued)
      assert.equal(next, queued)
      assert.equal(next.executionGeneration, 3)
    })

    it('illegal from running / paused / completed', () => {
      for (const status of ['running', 'paused', 'completed', 'cancelled'] as const) {
        assert.throws(() => svc.retry(job(status)), JobDomainError)
      }
    })
  })

  describe('start / markFailed / enterVerification / complete', () => {
    it('start: queued → running', () => {
      assert.equal(svc.start(job('queued')).status, 'running')
    })

    it('start illegal when not queued', () => {
      assert.throws(() => svc.start(job('running')), JobDomainError)
    })

    it('enterVerification: running → verification', () => {
      assert.equal(svc.enterVerification(job('running')).status, 'verification')
    })

    it('complete only from verification', () => {
      assert.equal(svc.complete(job('verification')).status, 'completed')
      assert.throws(() => svc.complete(job('running')), JobDomainError)
    })

    it('markFailed from running / pausing / verification', () => {
      assert.equal(svc.markFailed(job('running')).status, 'failed')
      assert.equal(svc.markFailed(job('pausing')).status, 'failed')
      assert.equal(svc.markFailed(job('verification')).status, 'failed')
      assert.throws(() => svc.markFailed(job('paused')), JobDomainError)
    })
  })

  describe('executionGeneration immutability', () => {
    it('pause / continue / cancel / complete preserve generation', () => {
      const gen = 7
      assert.equal(svc.pause(job('queued', { executionGeneration: gen })).executionGeneration, gen)
      assert.equal(svc.continue(job('paused', { executionGeneration: gen })).executionGeneration, gen)
      assert.equal(svc.cancel(job('running', { executionGeneration: gen })).executionGeneration, gen)
      assert.equal(
        svc.complete(job('verification', { executionGeneration: gen })).executionGeneration,
        gen
      )
      assert.equal(
        svc.enterVerification(job('running', { executionGeneration: gen })).executionGeneration,
        gen
      )
    })

    it('only retry opens a new generation', () => {
      const before = job('failed', { executionGeneration: 2 })
      const after = svc.retry(before)
      assert.equal(after.executionGeneration, 3)
    })
  })

  describe('happy path table', () => {
    const cases: Array<{
      name: string
      from: JobStatus
      run: (j: Job) => Job
      to: JobStatus
    }> = [
      { name: 'start', from: 'queued', run: (j) => svc.start(j), to: 'running' },
      {
        name: 'enterVerification',
        from: 'running',
        run: (j) => svc.enterVerification(j),
        to: 'verification'
      },
      { name: 'complete', from: 'verification', run: (j) => svc.complete(j), to: 'completed' },
      { name: 'pause-running', from: 'running', run: (j) => svc.pause(j), to: 'pausing' },
      { name: 'pause-queued', from: 'queued', run: (j) => svc.pause(j), to: 'paused' },
      { name: 'continue', from: 'paused', run: (j) => svc.continue(j), to: 'queued' },
      { name: 'markFailed', from: 'running', run: (j) => svc.markFailed(j), to: 'failed' },
      { name: 'retry-failed', from: 'failed', run: (j) => svc.retry(j), to: 'queued' }
    ]

    for (const c of cases) {
      it(`${c.name}: ${c.from} → ${c.to}`, () => {
        assert.equal(c.run(job(c.from)).status, c.to)
      })
    }
  })
})
