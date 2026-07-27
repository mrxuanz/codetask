import { writeSync } from 'fs'
import { turnErrorChunk } from '../server/agent-runtime/errors'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import type { AgentTurnChunk, AgentTurnInput } from '../server/agent-runtime/types'

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
  const inputFileFlag = process.argv.indexOf('--worker-input-file')
  const inputFile =
    inputFileFlag >= 0 && process.argv[inputFileFlag + 1]
      ? process.argv[inputFileFlag + 1]?.trim()
      : undefined
  if (inputFileFlag >= 0 && (!inputFile || inputFile.startsWith('--'))) {
    throw new Error('role-worker: invalid --worker-input-file argument')
  }
  let raw = ''
  if (inputFile) {
    const { readFile } = await import('fs/promises')
    raw = (await readFile(inputFile, 'utf8')).trim()
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    raw = Buffer.concat(chunks).toString('utf8').trim()
  }
  if (!raw) {
    throw new Error('role-worker: empty input (stdin or --worker-input-file)')
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
