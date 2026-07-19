import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIMEOUTS } from '../config/timeouts'
import type { ProcessRegistry } from './process-registry'
import { writeJson } from './run-layout'

export type CaseWorkerInput = {
  caseId: string
  caseRunId: string
  driver: 'fake' | 'opencode'
  mcpUrl: string
  capabilityId: string
  workspaceRoot: string
  agentRoot: string
  skillPaths: string[]
  fixturePath?: string
  timeoutMs: number
  resultPath: string
}

export type CaseWorkerResult = {
  ok: boolean
  classification?: string
  error?: string
  events?: unknown[]
  artifacts?: Record<string, unknown>
}

export async function runCaseWorker(
  input: CaseWorkerInput,
  options: {
    repoRoot: string
    registry: ProcessRegistry
  }
): Promise<CaseWorkerResult> {
  mkdirSync(input.agentRoot, { recursive: true })
  const contextPath = join(input.agentRoot, 'worker-context.json')
  writeJson(contextPath, input)

  const workerEntry = join(
    options.repoRoot,
    'tests/business-e2e/supervisor/case-worker-main.ts'
  )
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', workerEntry, '--context', contextPath],
    {
      cwd: options.repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    }
  )

  if (!child.pid) throw new Error('case_worker_spawn_failed')
  options.registry.track({
    label: `case-worker-${input.caseId}`,
    pid: child.pid,
    startedAt: Date.now(),
    caseRunId: input.caseRunId
  })

  let output = ''
  const forward = (stream: NodeJS.WritableStream, chunk: Buffer): void => {
    const text = chunk.toString()
    output += text
    stream.write(text)
  }
  child.stdout.on('data', (chunk) => forward(process.stdout, chunk))
  child.stderr.on('data', (chunk) => forward(process.stderr, chunk))

  const exitCode: number | null = await new Promise((resolve) => {
    // timeoutMs <= 0 means no worker kill timer — wait until the driver exits on API state.
    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            try {
              if (child.pid) options.registry.stopExact(child.pid)
            } catch {
              /* ignore */
            }
            resolve(null)
          }, input.timeoutMs + 5_000)
        : null
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      resolve(code)
    })
  })

  if (child.pid) options.registry.untrack(child.pid)

  if (existsSync(input.resultPath)) {
    return JSON.parse(readFileSync(input.resultPath, 'utf8')) as CaseWorkerResult
  }

  if (exitCode === null) {
    return { ok: false, classification: 'timeout', error: 'case_worker_timeout' }
  }
  return {
    ok: false,
    classification: 'runner_crash',
    error: `case_worker_exit_${exitCode}:${output.slice(-2000)}`
  }
}

export async function runCrashingWorker(options: {
  repoRoot: string
  registry: ProcessRegistry
  caseRunId: string
}): Promise<number | undefined> {
  const child = spawn(process.execPath, ['-e', 'process.exit(97)'], {
    cwd: options.repoRoot,
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  })
  if (!child.pid) throw new Error('crash_worker_spawn_failed')
  options.registry.track({
    label: 'crash-worker',
    pid: child.pid,
    startedAt: Date.now(),
    caseRunId: options.caseRunId
  })
  await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const pid = child.pid
  options.registry.untrack(pid)
  return pid
}

export function skillPath(repoRoot: string, name: string): string {
  return join(repoRoot, 'tests/business-e2e/skills', name, 'SKILL.md')
}

export function fixturePath(repoRoot: string, relative: string): string {
  return join(repoRoot, 'tests/business-e2e/fixtures', relative)
}

export function thisDir(): string {
  return fileURLToPath(new URL('.', import.meta.url))
}
