import { writeSync } from 'fs'
import { turnErrorChunk } from '../server/agent-runtime/errors'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import type { AgentTurnChunk, AgentTurnInput } from '../server/agent-runtime/types'

const INPUT_FILE_ARG_PREFIX = '--input-file='

function writeChunk(role: AgentTurnInput['role'], chunk: AgentTurnChunk): void {
  const compact = compactTurnChunkForIpc(role, chunk)
  if (!compact) return
  writeSync(1, `${JSON.stringify(compact)}\n`)
}

async function runTurn(input: AgentTurnInput): Promise<void> {
  // Role workers are only launched inside the OS outer sandbox; pass the control
  // explicitly on the turn options (PRU-12-05) — do not read CODETASK_OUTER_SANDBOX.
  const provider = getAgentTurnProvider(input.provider)
  for await (const chunk of provider.streamTurn(input, { outerSandbox: true })) {
    writeChunk(input.role, chunk)
  }
}

async function main(): Promise<void> {
  const fileArg = process.argv.find((arg) => arg.startsWith(INPUT_FILE_ARG_PREFIX))
  let raw = ''
  if (fileArg) {
    const { readFile } = await import('fs/promises')
    raw = (await readFile(fileArg.slice(INPUT_FILE_ARG_PREFIX.length), 'utf8')).trim()
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    raw = Buffer.concat(chunks).toString('utf8').trim()
  }
  if (!raw) {
    throw new Error('role-worker: empty input (stdin or --input-file=)')
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
