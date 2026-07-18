import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StartupCoordinator } from '../../../src/server/application/startup-coordinator'
import { decideStartupReconcile } from '../../../src/server/application/startup-reconciler'
import { ShutdownCoordinator } from '../../../src/server/application/shutdown-coordinator'
import { SafeLoggerImpl } from '../../../src/server/application/safe-logger'
import type { JobAggregate } from '@shared/contracts/control-plane'
import { LEGACY_RESUME_RUNNING_DISABLED } from '../../../src/server/application/legacy-resume-running-disabled'

function buildJob(overrides: Partial<JobAggregate> = {}): JobAggregate {
  return {
    id: 'job-1',
    threadId: 't1',
    projectId: 'p1',
    state: 'execution_running',
    stateRevision: 1,
    controlIntent: 'none',
    resumeTarget: null,
    currentPlanRevision: 1,
    executionGeneration: 0,
    activeRunId: 'run-1',
    lastFailureId: null,
    ...overrides
  }
}

const silentLogger = {
  debug() {
    void 0
  },
  info() {
    void 0
  },
  warn() {
    void 0
  },
  error() {
    void 0
  }
}

describe('StartupCoordinator', () => {
  describe('ensureReady', () => {
    it('should complete all stages successfully', async () => {
      const stages: string[] = []
      const coordinator = new StartupCoordinator({
        logger: silentLogger,
        stages: [
          {
            name: 'a',
            async execute() {
              stages.push('a')
            }
          },
          {
            name: 'b',
            async execute() {
              stages.push('b')
            }
          }
        ]
      })
      await coordinator.ensureReady()
      assert.equal(coordinator.getPhase(), 'ready')
      assert.deepEqual(stages, ['a', 'b'])
    })

    it('should be idempotent', async () => {
      let runs = 0
      const coordinator = new StartupCoordinator({
        logger: silentLogger,
        stages: [
          {
            name: 'once',
            async execute() {
              runs += 1
            }
          }
        ]
      })
      await coordinator.ensureReady()
      await coordinator.ensureReady()
      assert.equal(runs, 1)
      assert.equal(coordinator.getPhase(), 'ready')
    })

    it('should enter degraded on failure', async () => {
      const coordinator = new StartupCoordinator({
        logger: silentLogger,
        stages: [
          {
            name: 'boom',
            async execute() {
              throw new Error('boom')
            }
          }
        ]
      })
      await assert.rejects(() => coordinator.ensureReady(), /boom/)
      assert.equal(coordinator.getPhase(), 'degraded')
      assert.equal(coordinator.getLastError(), 'boom')
    })

    it('should allow retry after degraded', async () => {
      let failOnce = true
      const coordinator = new StartupCoordinator({
        logger: silentLogger,
        stages: [
          {
            name: 'flaky',
            async execute() {
              if (failOnce) {
                failOnce = false
                throw new Error('temp')
              }
            }
          }
        ]
      })
      await assert.rejects(() => coordinator.ensureReady())
      assert.equal(coordinator.getPhase(), 'degraded')
      await coordinator.ensureReady()
      assert.equal(coordinator.getPhase(), 'ready')
    })
  })
})

describe('decideStartupReconcile', () => {
  describe('pause intent', () => {
    it('should settle to paused', () => {
      const decision = decideStartupReconcile({
        job: buildJob({ state: 'pausing', controlIntent: 'pause', resumeTarget: 'execution_queued' }),
        runIsStale: false,
        interruptionReason: 'process_crash',
        hasRunningAttempt: false,
        hasLegacyActiveRuntime: false,
        runBelongsToCurrentBoot: false,
        hasActiveSlot: true,
        hasRegisteredRuntimeInstance: false,
        hasSupervisedLifecycleOperation: false,
        runtimeWasClosed: false
      })
      assert.equal(decision.kind, 'settle_paused')
    })
  })

  describe('no intent stale run', () => {
    it('should settle to recoverable failed', () => {
      const decision = decideStartupReconcile({
        job: buildJob({ state: 'execution_running', controlIntent: 'none' }),
        runIsStale: true,
        interruptionReason: 'process_crash',
        hasRunningAttempt: false,
        hasLegacyActiveRuntime: false,
        runBelongsToCurrentBoot: false,
        hasActiveSlot: false,
        hasRegisteredRuntimeInstance: false,
        hasSupervisedLifecycleOperation: false,
        runtimeWasClosed: false
      })
      assert.equal(decision.kind, 'settle_interrupted_failure')
    })
  })

  describe('current boot runtime lost', () => {
    it('should settle runtime lost', () => {
      const decision = decideStartupReconcile({
        job: buildJob({ state: 'execution_running' }),
        runIsStale: false,
        interruptionReason: 'process_crash',
        hasRunningAttempt: false,
        hasLegacyActiveRuntime: false,
        runBelongsToCurrentBoot: true,
        hasActiveSlot: false,
        hasRegisteredRuntimeInstance: false,
        hasSupervisedLifecycleOperation: false,
        runtimeWasClosed: true
      })
      assert.equal(decision.kind, 'settle_runtime_lost')
    })
  })

  describe('quarantine', () => {
    it('should quarantine queued with active run', () => {
      const decision = decideStartupReconcile({
        job: buildJob({ state: 'execution_queued', activeRunId: 'run-1' }),
        runIsStale: false,
        interruptionReason: 'process_crash',
        hasRunningAttempt: false,
        hasLegacyActiveRuntime: false,
        runBelongsToCurrentBoot: false,
        hasActiveSlot: false,
        hasRegisteredRuntimeInstance: false,
        hasSupervisedLifecycleOperation: false,
        runtimeWasClosed: false
      })
      assert.equal(decision.kind, 'quarantine')
    })
  })
})

describe('ShutdownCoordinator', () => {
  describe('shutdown', () => {
    it('should stop scheduler flush outbox and close runtimes', async () => {
      const steps: string[] = []
      const coordinator = new ShutdownCoordinator({
        scheduler: {
          async stop() {
            steps.push('scheduler')
          }
        },
        outboxDispatcher: {
          async flushWithin() {
            steps.push('outbox')
          }
        },
        runtimeSupervisor: {
          async closeAll() {
            steps.push('runtimes')
          }
        },
        logger: silentLogger
      })
      await coordinator.shutdown('app_shutdown')
      assert.deepEqual(steps, ['scheduler', 'outbox', 'runtimes'])
      assert.equal(coordinator.isDraining(), true)
    })
  })
})

describe('SafeLogger', () => {
  describe('stream error handling', () => {
    it('should not throw when logging after install', () => {
      const logger = new SafeLoggerImpl()
      assert.doesNotThrow(() => {
        logger.info('hello')
        logger.warn('warn')
        logger.error('error')
      })
    })
  })
})

describe('legacy resume running', () => {
  it('should enable auto resume for interrupted running jobs (FIX-PLAN F3-A)', () => {
    assert.equal(LEGACY_RESUME_RUNNING_DISABLED, false)
  })
})
