import { createInterface } from 'node:readline'
import { writeSync } from 'node:fs'
import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import { closeJobCursorRuntime } from '../server/agent-runtime/cursor-acp/stream-session-turn'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import type { AgentTurnChunk, AgentTurnInput } from '../server/agent-runtime/types'
import { formatSdkTurnError } from '../server/agent-runtime/errors'

const TURN_DONE_MARKER = '{"type":"_turn_done"}'
const cursorProvider = getAgentTurnProvider('cursorcli')

function writeChunk(role: AgentTurnInput['role'], chunk: AgentTurnChunk): void {
  const compact = compactTurnChunkForIpc(role, chunk)
  if (!compact) return
  writeSync(1, `${JSON.stringify(compact)}\n`)
}

function writeTurnDone(): void {
  writeSync(1, `${TURN_DONE_MARKER}\n`)
}

async function runTurn(input: AgentTurnInput): Promise<void> {
  // Role workers are only launched inside the OS outer sandbox; pass the control
  // explicitly on the turn options (PRU-12-05) — do not read CODETASK_OUTER_SANDBOX.
  if (input.provider !== 'cursorcli') {
    throw new Error(`role-worker-cursor-job only supports cursorcli, got ${input.provider}`)
  }
  if (!input.jobId?.trim()) {
    throw new Error('role-worker-cursor-job requires jobId on input')
  }

  for await (const chunk of cursorProvider.streamTurn(input, { outerSandbox: true })) {
    writeChunk(input.role, chunk)
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let activeJobId: string | null = null

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parsed = JSON.parse(trimmed) as { type?: string; jobId?: string } & AgentTurnInput
    if (parsed.type === '_close') {
      if (activeJobId) {
        await closeJobCursorRuntime(activeJobId).catch(() => {})
      }
      break
    }

    try {
      await runTurn(parsed)
      activeJobId = parsed.jobId ?? activeJobId
      writeTurnDone()
    } catch (error) {
      const message = formatSdkTurnError(error)
      writeChunk(parsed.role, { type: 'error', message })
      writeTurnDone()
      if (parsed.jobId) {
        await closeJobCursorRuntime(parsed.jobId).catch(() => {})
      }
    }
  }

  if (activeJobId) {
    await closeJobCursorRuntime(activeJobId).catch(() => {})
  }
}

main()
  .then(() => setImmediate(() => process.exit(0)))
  .catch((error) => {
    const message = formatSdkTurnError(error)
    writeChunk('task-worker', { type: 'error', message })
    process.stderr.write(`[role-worker-cursor-job] ${message}\n`)
    process.exit(1)
  })
