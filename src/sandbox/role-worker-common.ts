import { writeSync } from 'fs'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import type {
  AgentTurnChunk,
  AgentTurnInput,
  AgentTurnProvider
} from '../server/agent-runtime/types'
import { formatSdkTurnError } from '../server/agent-runtime/errors'

const INPUT_FILE_ARG_PREFIX = '--input-file='

function writeChunk(role: AgentTurnInput['role'], chunk: AgentTurnChunk): void {
  const compact = compactTurnChunkForIpc(role, chunk)
  if (!compact) return
  writeSync(1, `${JSON.stringify(compact)}\n`)
}

async function runTurn(provider: AgentTurnProvider, input: AgentTurnInput): Promise<void> {
  // Role workers are only launched inside the OS outer sandbox; pass the control
  // explicitly on the turn options (PRU-12-05) — do not read CODETASK_OUTER_SANDBOX.
  if (input.provider !== provider.code) {
    throw new Error(`role-worker-${provider.code} cannot run provider ${input.provider}`)
  }

  const stream = provider.streamTurn(input, { outerSandbox: true })

  for await (const chunk of stream) {
    writeChunk(input.role, chunk)
  }
}

async function readInput(): Promise<AgentTurnInput> {
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
  return JSON.parse(raw) as AgentTurnInput
}

export function runRoleWorker(provider: AgentTurnProvider): void {
  readInput()
    .then(async (input) => {
      await runTurn(provider, input)

      setImmediate(() => process.exit(0))
    })
    .catch((error) => {
      const message = formatSdkTurnError(error)
      writeChunk('task-worker', { type: 'error', message })
      process.stderr.write(`[role-worker] ${message}\n`)
      process.exit(1)
    })
}
