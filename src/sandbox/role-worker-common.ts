import { writeSync } from 'fs'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import type {
  AgentTurnChunk,
  AgentTurnInput,
  AgentTurnProvider
} from '../server/agent-runtime/types'
import { formatSdkTurnError } from '../server/agent-runtime/errors'

function writeChunk(role: AgentTurnInput['role'], chunk: AgentTurnChunk): void {
  const compact = compactTurnChunkForIpc(role, chunk)
  if (!compact) return
  writeSync(1, `${JSON.stringify(compact)}\n`)
}

async function runTurn(provider: AgentTurnProvider, input: AgentTurnInput): Promise<void> {
  const outerSandbox = process.env.CODETASK_OUTER_SANDBOX === '1'
  if (!outerSandbox) {
    throw new Error('role-worker must run inside outer sandbox (CODETASK_OUTER_SANDBOX=1)')
  }
  if (input.provider !== provider.code) {
    throw new Error(`role-worker-${provider.code} cannot run provider ${input.provider}`)
  }

  const stream = provider.streamTurn(input, { outerSandbox: true })

  for await (const chunk of stream) {
    writeChunk(input.role, chunk)
  }
}

async function readInput(): Promise<AgentTurnInput> {
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
