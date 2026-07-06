import { writeSync } from 'fs'
import { turnErrorChunk } from '../server/agent-runtime/errors'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import { streamCodexTurn } from '../server/agent-runtime/providers/codex-sdk'
import { streamClaudeTurn } from '../server/agent-runtime/providers/claude-sdk'
import { streamOpencodeTurn } from '../server/agent-runtime/providers/opencode-sdk'
import { streamCursorAcpTurn } from '../server/agent-runtime/providers/cursor-acp'
import type { AgentTurnChunk, AgentTurnInput } from '../server/agent-runtime/types'

function writeChunk(role: AgentTurnInput['role'], chunk: AgentTurnChunk): void {
  const compact = compactTurnChunkForIpc(role, chunk)
  if (!compact) return
  writeSync(1, `${JSON.stringify(compact)}\n`)
}

async function runTurn(input: AgentTurnInput): Promise<void> {
  const outerSandbox = process.env.CODETASK_OUTER_SANDBOX === '1'
  if (!outerSandbox) {
    throw new Error('role-worker must run inside outer sandbox (CODETASK_OUTER_SANDBOX=1)')
  }

  let stream: AsyncGenerator<AgentTurnChunk>
  if (input.provider === 'codex') {
    stream = streamCodexTurn(input, { outerSandbox: true })
  } else if (input.provider === 'claude-code') {
    stream = streamClaudeTurn(input, { outerSandbox: true })
  } else if (input.provider === 'opencode') {
    stream = streamOpencodeTurn(input, { outerSandbox: true })
  } else if (input.provider === 'cursorcli') {
    stream = streamCursorAcpTurn(input, { outerSandbox: true })
  } else {
    throw new Error(`unsupported provider: ${input.provider}`)
  }

  for await (const chunk of stream) {
    writeChunk(input.role, chunk)
  }
}

async function main(): Promise<void> {
  const inputFile = process.env.CODETASK_WORKER_INPUT_FILE?.trim()
  const envInput = process.env.CODETASK_WORKER_INPUT?.trim()
  let raw = ''
  if (inputFile) {
    const { readFile } = await import('fs/promises')
    raw = (await readFile(inputFile, 'utf8')).trim()
  } else if (envInput) {
    raw = envInput
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    raw = Buffer.concat(chunks).toString('utf8').trim()
  }
  if (!raw) {
    throw new Error(
      'role-worker: empty input (stdin, CODETASK_WORKER_INPUT, or CODETASK_WORKER_INPUT_FILE)'
    )
  }
  const input = JSON.parse(raw) as AgentTurnInput
  await runTurn(input)
}

main()
  .then(() => {
    setImmediate(() => process.exit(0))
  })
  .catch((error) => {
    const chunk = turnErrorChunk(error)
    writeChunk('task-worker', chunk)
    process.stderr.write(`[role-worker] ${chunk.message}\n`)
    process.exit(1)
  })
