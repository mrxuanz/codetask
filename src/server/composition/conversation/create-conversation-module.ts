import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { NodeSecureIdGenerator } from '../../adapters/security'
import { KernelSqliteDatabase, SqliteUnitOfWork } from '../../adapters/sqlite'
import { ConversationService } from '../../core/application/conversation'
import type { Clock } from '../../core/application/ports'
import { ConversationError } from '../../core/domain/conversation'
import { buildConversationProviderRuntimeScopeId } from '../../../shared/providers/capabilities'
import { buildProviderTurnContext, type ProviderDriver } from '../../providers/driver'
import { createProviderRegistry } from '../../providers/composition'
import { ProviderRuntimeManager } from '../../providers/lifecycle'
import type { HostEnvironmentSnapshot } from '../../host-environment'
import { ProviderAuthError } from '../../sandbox/provider-auth/errors'
import type { ProviderInstallation } from '../../../shared/providers/installation'

class SystemClock implements Clock {
  nowMs(): number {
    return Date.now()
  }
}

export interface ConversationProviderStatus {
  readonly code: 'cursorcli'
  readonly label: 'Cursor CLI'
  readonly installed: boolean
  readonly authenticated: boolean
  readonly authMode: 'host-login'
  readonly loginCommand: 'agent login'
  readonly statusCommand: 'agent status'
  readonly message: string
}

export type ConversationStreamEvent =
  | {
      readonly type: 'started'
      readonly turnId: string
      readonly workspaceAccess: 'read-only' | 'write'
    }
  | { readonly type: 'delta'; readonly content: string }
  | { readonly type: 'thinking'; readonly content: string }
  | {
      readonly type: 'completed'
      readonly messageId: string
      readonly reply: string
      readonly runtimeSessionId: string | null
    }

export interface ConversationModule {
  readonly service: ConversationService
  providerStatus(): Promise<ConversationProviderStatus>
  workspaceAccess(workspaceId: string): 'read-only' | 'write'
  streamTurn(input: {
    readonly userId: string
    readonly threadId: string
    readonly prompt: string
    readonly signal?: AbortSignal | undefined
  }): AsyncGenerator<ConversationStreamEvent>
  shutdown(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  if (error instanceof ProviderAuthError) return error.code
  if (error instanceof ConversationError) return error.code
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'conversation.provider_failed'
}

export function createConversationModule(input: {
  readonly database: KernelSqliteDatabase
  readonly runtimeRoot: string
  readonly hostEnvironment: HostEnvironmentSnapshot
  readonly cursorDriver?: ProviderDriver | undefined
  readonly runtimeManager?: ProviderRuntimeManager | undefined
  readonly clock?: Clock | undefined
  readonly workspaceIsWriteLocked?: ((workspaceId: string) => boolean) | undefined
}): ConversationModule {
  const service = new ConversationService({
    unitOfWork: new SqliteUnitOfWork(input.database),
    clock: input.clock ?? new SystemClock(),
    ids: new NodeSecureIdGenerator()
  })
  const driver = input.cursorDriver ?? createProviderRegistry().get('cursorcli')
  const runtimeManager = input.runtimeManager ?? new ProviderRuntimeManager()

  async function discoverCursor(): Promise<ProviderInstallation | null> {
    return driver.discover({
      hostEnvironment: input.hostEnvironment,
      settings: driver.settings,
      installDirs: driver.installDirs(input.hostEnvironment)
    })
  }

  return Object.freeze({
    service,
    workspaceAccess(workspaceId: string): 'read-only' | 'write' {
      return input.workspaceIsWriteLocked?.(workspaceId) === true ? 'read-only' : 'write'
    },
    async providerStatus(): Promise<ConversationProviderStatus> {
      const installation = await discoverCursor()
      if (!installation) {
        return {
          code: 'cursorcli',
          label: 'Cursor CLI',
          installed: false,
          authenticated: false,
          authMode: 'host-login',
          loginCommand: 'agent login',
          statusCommand: 'agent status',
          message: 'Cursor Agent CLI is not installed.'
        }
      }

      const probeRoot = join(input.runtimeRoot, 'provider-status', 'cursorcli')
      mkdirSync(probeRoot, { recursive: true })
      const prepared = driver.prepareAuth({
        runtimeRoot: probeRoot,
        workspaceRoot: probeRoot,
        hostEnvironment: input.hostEnvironment
      })
      try {
        driver.preflight({ installation, preparedAuth: prepared })
        return {
          code: 'cursorcli',
          label: 'Cursor CLI',
          installed: true,
          authenticated: true,
          authMode: 'host-login',
          loginCommand: 'agent login',
          statusCommand: 'agent status',
          message: 'Authenticated with the Cursor account on this host.'
        }
      } catch (error) {
        return {
          code: 'cursorcli',
          label: 'Cursor CLI',
          installed: true,
          authenticated: false,
          authMode: 'host-login',
          loginCommand: 'agent login',
          statusCommand: 'agent status',
          message: errorMessage(error)
        }
      } finally {
        prepared.cleanupPlan()
      }
    },
    async *streamTurn(turnInput: {
      readonly userId: string
      readonly threadId: string
      readonly prompt: string
      readonly signal?: AbortSignal | undefined
    }): AsyncGenerator<ConversationStreamEvent> {
      const started = service.beginTurn(turnInput.userId, turnInput.threadId, turnInput.prompt)
      const workspaceLocked = input.workspaceIsWriteLocked?.(started.workspace.id) === true
      yield {
        type: 'started',
        turnId: started.turn.id,
        workspaceAccess: workspaceLocked ? 'read-only' : 'write'
      }

      const turnRuntimeRoot = join(input.runtimeRoot, started.thread.id)
      mkdirSync(turnRuntimeRoot, { recursive: true })
      let preparedCleanup: (() => void) | null = null

      try {
        const installation = await discoverCursor()
        if (!installation) {
          throw new ConversationError('conversation.provider_unavailable')
        }
        const prepared = driver.prepareAuth({
          runtimeRoot: turnRuntimeRoot,
          workspaceRoot: started.workspace.rootPath,
          hostEnvironment: input.hostEnvironment
        })
        preparedCleanup = prepared.cleanupPlan
        try {
          driver.preflight({ installation, preparedAuth: prepared })
        } catch (error) {
          if (error instanceof ProviderAuthError) {
            throw new ConversationError('conversation.provider_not_authenticated', {
              action: 'agent login'
            })
          }
          throw error
        }

        const context = buildProviderTurnContext({
          input: {
            provider: 'cursorcli',
            role: 'conversation',
            cwd: started.workspace.rootPath,
            runtimeRoot: turnRuntimeRoot,
            prompt: started.prompt,
            systemPrompt: workspaceLocked
              ? 'A Job currently owns this workspace. This conversation is strictly read-only: inspect and explain, but do not edit files, execute mutating commands, or start implementation.'
              : undefined,
            runtimeSessionId: started.thread.runtimeSessionId,
            model: started.turn.model ?? undefined,
            capabilityProfile: workspaceLocked ? 'chat-read' : 'chat-write',
            installation,
            providerSettings: driver.settings,
            providerRuntimeScopeId: buildConversationProviderRuntimeScopeId(
              started.thread.id,
              'chat'
            )
          },
          options: {
            outerSandbox: false,
            signal: turnInput.signal
          },
          installation,
          authMode: driver.descriptor.capabilities.authMode
        })

        let reply = ''
        let runtimeSessionId: string | null = started.thread.runtimeSessionId
        for await (const chunk of runtimeManager.stream(driver, context)) {
          if (chunk.type === 'delta') {
            reply += chunk.content
            yield { type: 'delta', content: chunk.content }
          } else if (chunk.type === 'thinking_delta') {
            yield { type: 'thinking', content: chunk.content }
          } else if (chunk.type === 'completed') {
            reply = chunk.reply || reply
            runtimeSessionId = chunk.runtimeSessionId
          } else {
            throw new Error(chunk.message)
          }
        }

        const message = service.completeTurn({
          turnId: started.turn.id,
          threadId: started.thread.id,
          reply,
          runtimeSessionId
        })
        yield {
          type: 'completed',
          messageId: message.id,
          reply,
          runtimeSessionId
        }
      } catch (error) {
        const cancelled = turnInput.signal?.aborted === true
        service.failTurn(started.turn.id, {
          cancelled,
          code: errorCode(error),
          message: errorMessage(error)
        })
        throw error
      } finally {
        preparedCleanup?.()
      }
    },
    shutdown(): Promise<void> {
      return runtimeManager.closeAll()
    }
  })
}
