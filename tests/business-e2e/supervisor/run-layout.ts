import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

export function createRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

export function createCaseRunId(caseId: string): string {
  return `${caseId}-${randomBytes(4).toString('hex')}`
}

export function ensureRunLayout(runRoot: string): {
  data: string
  bootstrap: string
  workspaces: string
  agents: string
  skills: string
  cases: string
  reports: string
  logs: string
  pids: string
  credentials: string
} {
  const dirs = {
    data: join(runRoot, 'data'),
    bootstrap: join(runRoot, 'bootstrap'),
    workspaces: join(runRoot, 'workspaces'),
    agents: join(runRoot, 'agents'),
    skills: join(runRoot, 'skills'),
    cases: join(runRoot, 'cases'),
    reports: join(runRoot, 'reports'),
    logs: join(runRoot, 'logs'),
    pids: join(runRoot, 'pids'),
    credentials: join(runRoot, 'credentials')
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function randomAccount(): { username: string; password: string } {
  const suffix = randomBytes(3).toString('hex')
  return {
    username: `biz${suffix}`,
    password: `BizPass1!${suffix}`
  }
}

export function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

export function assertExists(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label}_missing:${path}`)
}
