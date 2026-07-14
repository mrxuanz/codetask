import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeExit, RuntimeHandle } from '../../../src/server/application/runtime-supervisor'
import {
  bootAuthoritativeRuntime,
  countOpenSlots,
  getControlPlaneRuntime,
  getSqliteClient,
  seedControlJob,
  seedControlRun,
  seedControlSlot,
  withCompositionContext
} from './fixtures'
import { closeProductionRuntimeBinding } from '../../../src/server/application/control-plane-runtime'

class ControllableRuntimeHandle implements RuntimeHandle {
  private resolveClosed!: (exit: RuntimeExit) => void
  readonly closed = new Promise<RuntimeExit>((resolve) => {
    this.resolveClosed = resolve
  })

  requestStopCalls = 0

  constructor(
    readonly runtimeInstanceId: string,
    readonly runId: string
  ) {}

  async requestStop(): Promise<void> {
    this.requestStopCalls += 1
  }

  async hardKill(): Promise<void> {
    this.requestStopCalls += 1
  }

  exit(exit: RuntimeExit): void {
    this.resolveClosed(exit)
  }
}

describe('composition: runtime close order (D05)', () => {
  it('keeps slot held until provider handle.closed resolves', async () => {
    await withCompositionContext(
      {
        generation: 'v3_authoritative',
        seed(db) {
          seedControlJob(db, {
            jobId: 'job-1',
            username: 'u1',
            state: 'execution_running',
            stateRevision: 2,
            activeRunId: 'run-1'
          })
          seedControlRun(db, { runId: 'run-1', jobId: 'job-1', kind: 'execution', state: 'active' })
          seedControlSlot(db, { runId: 'run-1', jobId: 'job-1', state: 'active' })
        }
      },
      async (ctx) => {
        await bootAuthoritativeRuntime(ctx)
        const runtime = getControlPlaneRuntime(ctx)
        const db = getSqliteClient(ctx)

        let resolveClosed!: (exit: RuntimeExit) => void
        const closed = new Promise<RuntimeExit>((resolve) => {
          resolveClosed = resolve
        })

        const binding = {
          jobId: 'job-1',
          runId: 'run-1',
          kind: 'execution' as const,
          runtimeInstanceId: 'rt-test-1',
          closed,
          resolveClosed,
          stopPromise: null as Promise<void> | null,
          closeSettled: false,
          abortController: new AbortController()
        }

        runtime.bindingsByRunId.set('run-1', binding)
        runtime.activeRunByJobId.set('job-1', 'run-1')
        const handle = new ControllableRuntimeHandle('rt-test-1', 'run-1')
        runtime.runtimeSupervisor.register(handle)

        const closePromise = closeProductionRuntimeBinding(runtime, 'run-1', 'paused')

        await Promise.resolve()
        assert.equal(
          countOpenSlots(db),
          1,
          'slot must remain held until handle.closed resolves'
        )

        binding.resolveClosed({ kind: 'normal' })
        handle.exit({ kind: 'normal' })
        await closePromise

        assert.equal(countOpenSlots(db), 0, 'slot must release only after handle.closed resolves')
      }
    )
  })
})
