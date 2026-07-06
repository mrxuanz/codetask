import type { SupportedCoreCode } from '../../src/server/conversation/cores'
import type {
  AgentTurnChunk,
  AgentTurnInput,
  AgentTurnOptions,
  AgentTurnProvider
} from '../../src/server/agent-runtime/types'
import type { ConversationRole } from '../../src/server/agent-runtime/roles'
import { McpHttpClient } from './mcp-client'

export interface FakeMcpCall {
  tool: string
  args: Record<string, unknown>
}

export interface FakeTurnScript {
  reply?: string
  mcpCalls?: FakeMcpCall[]
  hang?: boolean
  failStart?: Error
}

export type FakeScriptResolver = (input: AgentTurnInput) => FakeTurnScript

export class FakeScriptRegistry {
  private readonly scripts = new Map<string, FakeTurnScript | FakeTurnScript[]>()
  private readonly counters = new Map<string, number>()
  private argResolver:
    | ((tool: string, args: Record<string, unknown>) => Record<string, unknown>)
    | null = null

  setArgResolver(
    resolver: (tool: string, args: Record<string, unknown>) => Record<string, unknown>
  ): void {
    this.argResolver = resolver
  }

  resolveArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    return this.argResolver ? this.argResolver(tool, args) : args
  }

  set(key: string, script: FakeTurnScript): void {
    this.scripts.set(key, script)
  }

  pushQueue(key: string, scripts: FakeTurnScript[]): void {
    this.scripts.set(key, [...scripts])
  }

  private defaultTaskWorkerScript: FakeTurnScript | null = null

  setDefaultTaskWorkerScript(script: FakeTurnScript): void {
    this.defaultTaskWorkerScript = script
  }

  resolve(input: AgentTurnInput): FakeTurnScript {
    const key = this.resolveKey(input)
    const entry = this.scripts.get(key)
    if (!entry) {
      if (key.startsWith('task-worker:') && this.defaultTaskWorkerScript) {
        return this.defaultTaskWorkerScript
      }
      return { reply: `fake:${key}`, mcpCalls: [] }
    }
    if (Array.isArray(entry)) {
      const index = this.counters.get(key) ?? 0
      const script = entry[Math.min(index, entry.length - 1)] ?? { reply: 'done' }
      this.counters.set(key, index + 1)
      return script
    }
    return entry
  }

  bumpCounter(key: string): number {
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }

  getCounter(key: string): number {
    return this.counters.get(key) ?? 0
  }

  reset(): void {
    this.scripts.clear()
    this.counters.clear()
    this.argResolver = null
    this.defaultTaskWorkerScript = null
  }

  resolveKey(input: AgentTurnInput): string {
    if (input.mcpUrl) {
      const url = new URL(input.mcpUrl)
      if (input.role === 'task-worker') {
        return `task-worker:${url.searchParams.get('taskId') ?? 'unknown'}`
      }
      if (input.role === 'slice-verifier') {
        const sliceId = url.searchParams.get('sliceId') ?? 'unknown'
        const attempt = this.bumpCounter(`slice-verifier:${sliceId}`) - 1
        return `slice-verifier:${sliceId}:${attempt}`
      }
      if (input.role === 'milestone-verifier') {
        const milestoneId = url.searchParams.get('milestoneId') ?? 'm1'
        const attempt = this.bumpCounter(`milestone-verifier:${milestoneId}`) - 1
        return `milestone-verifier:${milestoneId}:${attempt}`
      }
      if (input.role === 'planner') {
        return 'planner:0'
      }
      if (input.role === 'conversation') {
        const stage = url.searchParams.get('wizardStage') ?? 'general'
        const turn = this.bumpCounter(`conversation:${stage}:${input.provider}`)
        return `conversation:${stage}:${input.provider}:${turn}`
      }
    }

    const turn = this.bumpCounter(`conversation:general:${input.provider}`)
    return `conversation:general:${input.provider}:${turn}`
  }
}

async function runMcpCalls(
  mcpUrl: string | undefined,
  calls: FakeMcpCall[],
  registry: FakeScriptRegistry
): Promise<void> {
  if (!mcpUrl || calls.length === 0) return
  const client = new McpHttpClient(mcpUrl)
  await client.initialize()
  for (const call of calls) {
    const args = registry.resolveArgs(call.tool, call.args)
    await client.callTool(call.tool, args)
  }
}

export function createFakeAgentProvider(
  code: SupportedCoreCode,
  registry: FakeScriptRegistry
): AgentTurnProvider {
  async function* streamTurn(
    input: AgentTurnInput,
    options?: AgentTurnOptions
  ): AsyncGenerator<AgentTurnChunk> {
    const script = registry.resolve(input)
    if (script.failStart) {
      throw script.failStart
    }

    const reply = script.reply ?? `(${code} fake turn)`
    yield { type: 'delta', content: reply }

    if (script.hang) {
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted) {
          reject(new Error('对话已取消'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('作业已暂停'))
          },
          { once: true }
        )
      })
      return
    }

    await runMcpCalls(input.mcpUrl, script.mcpCalls ?? [], registry)

    yield {
      type: 'completed',
      reply,
      runtimeSessionId: `fake-${code}-session`
    }
  }

  return { code, protocol: 'fake', streamTurn }
}

export function registerFakeProviders(
  registry: FakeScriptRegistry,
  codes: SupportedCoreCode[] = ['codex', 'cursorcli', 'claude-code', 'opencode']
): Record<SupportedCoreCode, AgentTurnProvider> {
  const overrides = {} as Record<SupportedCoreCode, AgentTurnProvider>
  for (const code of codes) {
    overrides[code] = createFakeAgentProvider(code, registry)
  }
  return overrides
}

export function scriptKey(role: ConversationRole, parts: string[]): string {
  return [role, ...parts].join(':')
}
