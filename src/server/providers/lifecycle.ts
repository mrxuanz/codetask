import { randomUUID } from 'node:crypto'
import type { ProviderReusePolicy } from '../../shared/providers/capabilities'
import type { AgentTurnChunk } from '../agent-runtime/types'
import type { ConversationRole } from '../agent-runtime/roles'
import type { AgentCapabilityProfile } from '../agent-runtime/capabilities'
import type { PreparedProviderTurn, ProviderDriver, ProviderTurnContext } from './driver'
import type { ProviderRuntimeScope } from '../../shared/providers/capabilities'

export function resolveProviderReusePolicy(
  role: ConversationRole,
  capabilityProfile?: AgentCapabilityProfile
): ProviderReusePolicy {
  if (role !== 'conversation' || capabilityProfile === 'chat-write') return 'one-shot'
  return 'conversation-scoped'
}

export class ProviderRuntimeManager {
  private readonly active = new Map<string, PreparedProviderTurn>()
  private readonly managedDrivers = new Set<ProviderDriver>()
  private draining = false

  private createScope(id: string, context: ProviderTurnContext): ProviderRuntimeScope {
    const reusePolicy = resolveProviderReusePolicy(
      context.input.role,
      context.input.capabilityProfile
    )
    if (reusePolicy === 'one-shot') {
      return Object.freeze({ id: `turn:${id}`, reusePolicy })
    }
    const scopeId =
      context.input.providerRuntimeScopeId?.trim() || `conversation:${context.controls.runtimeRoot}`
    return Object.freeze({ id: scopeId, reusePolicy })
  }

  async *stream(
    driver: ProviderDriver,
    context: ProviderTurnContext
  ): AsyncGenerator<AgentTurnChunk> {
    if (this.draining) {
      throw new Error('Provider runtime manager is draining')
    }
    const id = randomUUID()
    const runtimeScope = this.createScope(id, context)
    const scopedContext: ProviderTurnContext = {
      ...context,
      runtimeScope,
      input: {
        ...context.input,
        providerSettings: context.input.providerSettings ?? driver.settings,
        providerRuntimeScope: runtimeScope
      }
    }
    const prepared = await driver.prepareTurn(scopedContext)
    this.managedDrivers.add(driver)
    this.active.set(id, prepared)
    let completed: Extract<AgentTurnChunk, { type: 'completed' }> | null = null
    let failure: unknown

    try {
      for await (const chunk of prepared.stream(context.options?.signal)) {
        if (chunk.type === 'completed') {
          completed = chunk
          continue
        }
        yield chunk
      }
    } catch (error) {
      failure = error
      await prepared.cancel(error instanceof Error ? error : new Error(String(error)))
    } finally {
      try {
        await prepared.close()
      } catch (closeError) {
        failure ??= closeError
      } finally {
        this.active.delete(id)
      }
    }

    if (failure) throw failure
    if (completed) yield completed
  }

  async closeAll(reason = new Error('Provider runtime manager closing')): Promise<void> {
    this.draining = true
    const handles = [...this.active.values()]
    const drivers = [...this.managedDrivers]
    const turnResults = await Promise.allSettled(
      handles.map(async (handle) => {
        await handle.cancel(reason)
        await handle.close()
      })
    )
    this.active.clear()
    const driverResults = await Promise.allSettled(
      drivers.map(async (driver) => {
        await driver.shutdown?.()
      })
    )
    this.managedDrivers.clear()
    const failures = [...turnResults, ...driverResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to close Provider runtimes')
    }
  }

  activeCount(): number {
    return this.active.size
  }

  beginDrain(): void {
    this.draining = true
  }
}
