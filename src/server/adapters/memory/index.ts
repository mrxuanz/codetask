import type { IdempotencyRecord, IdempotencyStore } from '../../core/application/idempotency'
import type { ApplicationEvent, EventPublisher } from '../../core/application/ports/event-publisher'
import type {
  ArtifactMeta,
  ArtifactStore,
  ArtifactWriteHandle
} from '../../core/application/ports/artifact-store'
import type {
  ProviderPort,
  ProviderRegistryPort
} from '../../core/application/ports/provider-registry'
import type { ExecutionRuntimePort, OpenTurnRequest } from '../../core/application/ports/execution-runtime'
import { InMemoryUnitOfWork } from './in-memory-uow'
import { InMemoryThreadRepo } from './in-memory-thread-repo'
import { InMemoryDraftRepo } from './in-memory-draft-repo'
import { InMemoryPlanRepo } from './in-memory-plan-repo'
import { InMemoryJobRepo } from './in-memory-job-repo'
import { FakeProvider } from './fake-provider'
import {
  InMemoryAttemptRepo,
  InMemoryTaskProjectionRepo
} from './in-memory-task-repos'
import { InMemoryWorkspaceLeaseRepo } from './in-memory-lease-repo'
import { InMemoryVerificationAttemptRepo } from './in-memory-verification-repo'
import { InMemoryRetentionStore } from './in-memory-retention-store'

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>()

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.store.get(key)
    return record ? { ...record } : undefined
  }

  async put(key: string, record: IdempotencyRecord): Promise<void> {
    this.store.set(key, { ...record })
  }
}

export class RecordingEventPublisher implements EventPublisher {
  readonly published: ApplicationEvent[] = []
  fault: Error | null = null

  async publish(event: ApplicationEvent): Promise<void> {
    if (this.fault) throw this.fault
    this.published.push(event)
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly store = new Map<string, ArtifactMeta>()
  private readonly contents = new Map<string, Buffer[]>()
  /** When set, beginWrite commits fail after writing chunks (half-write). */
  failCommitWith: Error | null = null

  async putMeta(meta: ArtifactMeta): Promise<void> {
    this.store.set(meta.id, { ...meta })
  }

  async getMeta(id: string): Promise<ArtifactMeta | undefined> {
    const meta = this.store.get(id)
    return meta ? { ...meta } : undefined
  }

  async beginWrite(id: string, kind: string): Promise<ArtifactWriteHandle> {
    this.contents.set(id, [])
    this.store.set(id, { id, kind, incomplete: true })
    const chunks = this.contents.get(id)!

    return {
      id,
      writeChunk: async (chunk: Uint8Array | string): Promise<void> => {
        const buf =
          typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
        chunks.push(buf)
      },
      commit: async (meta?: Partial<ArtifactMeta>): Promise<ArtifactMeta> => {
        if (this.failCommitWith) {
          this.store.set(id, { id, kind, incomplete: true, ...meta })
          throw this.failCommitWith
        }
        const finalMeta: ArtifactMeta = {
          id,
          kind,
          incomplete: false,
          contentHash: meta?.contentHash,
          createdAtMs: meta?.createdAtMs ?? Date.now()
        }
        this.store.set(id, finalMeta)
        return finalMeta
      },
      abort: async (): Promise<void> => {
        this.store.delete(id)
        this.contents.delete(id)
      }
    }
  }
}

export class InMemoryProviderRegistry implements ProviderRegistryPort {
  private readonly providers = new Map<string, ProviderPort>()

  register(provider: ProviderPort): void {
    this.providers.set(provider.code, provider)
  }

  get(code: string): ProviderPort | undefined {
    return this.providers.get(code)
  }
}

export class FakeExecutionRuntime implements ExecutionRuntimePort {
  private counter = 0
  fault: Error | null = null
  timeoutMs: number | null = null

  async openTurn(req: OpenTurnRequest): Promise<{ turnId: string }> {
    if (this.fault) throw this.fault
    if (this.timeoutMs != null && req.timeoutMs != null && req.timeoutMs <= this.timeoutMs) {
      const err = new Error('runtime.timeout')
      err.name = 'TimeoutError'
      throw err
    }
    this.counter += 1
    void req.invocation
    return { turnId: `runtime-turn-${this.counter}` }
  }
}

export {
  InMemoryUnitOfWork,
  InMemoryThreadRepo,
  InMemoryDraftRepo,
  InMemoryPlanRepo,
  InMemoryJobRepo,
  FakeProvider,
  InMemoryTaskProjectionRepo,
  InMemoryAttemptRepo,
  InMemoryWorkspaceLeaseRepo,
  InMemoryVerificationAttemptRepo,
  InMemoryRetentionStore
}
