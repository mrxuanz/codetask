import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CursorAcpMcpServer } from '../mcp'
import { withCursorHostStateLock } from './cursor-host-state'

export function slugifyCursorProjectPath(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
}

export function resolveCursorWorkspaceProjectSlug(workspaceCwd: string): string {
  return slugifyCursorProjectPath(resolveGitProjectRoot(workspaceCwd.trim()))
}

function jsonString(value: string): string {
  return JSON.stringify(value)
}

function stringEntriesJson(entries: Array<{ name: string; value: string }>): string {
  if (!entries.length) return '{}'
  return `{${entries.map((entry) => `${jsonString(entry.name)}:${jsonString(entry.value)}`).join(',')}}`
}

function stringArrayJson(values: string[]): string {
  return `[${values.map((value) => jsonString(value)).join(',')}]`
}

function cursorAcpServerConfigJson(server: CursorAcpMcpServer): string {
  if (server.type === 'http' || server.url) {
    const fields = [`"url":${jsonString(server.url ?? '')}`]
    if (server.headers?.length) {
      fields.push(`"headers":${stringEntriesJson(server.headers)}`)
    }
    return `{${fields.join(',')}}`
  }

  const fields = [`"command":${jsonString(server.command ?? '')}`]
  if (server.args?.length) fields.push(`"args":${stringArrayJson(server.args)}`)
  return `{${fields.join(',')}}`
}

function cursorMcpApprovalId(
  name: string,
  projectRoot: string,
  server: CursorAcpMcpServer
): string {
  const payload = `{"path":${jsonString(projectRoot)},"server":${cursorAcpServerConfigJson(server)}}`
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16)
  return `${name}-${digest}`
}

function resolveGitProjectRoot(cwd: string): string {
  let current = cwd
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return cwd
}

export function resolveCursorDataDir(env: Record<string, string>): string {
  const explicit = env.CURSOR_DATA_DIR?.trim()
  if (explicit) return explicit

  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  if (home) return join(home, '.cursor')

  const appData = env.APPDATA?.trim()
  if (appData) return join(appData, 'Cursor')

  return join(process.cwd(), '.cursor')
}

function readApprovalIds(path: string): string[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, path)
}

export async function materializeCursorMcpApprovals(input: {
  cwd: string
  servers: CursorAcpMcpServer[]
  env: Record<string, string>
}): Promise<{ approvalsPath: string } | null> {
  const approvalIds = input.servers
    .filter((server) => server.name.trim())
    .map((server) => cursorMcpApprovalId(server.name, resolveGitProjectRoot(input.cwd), server))

  if (approvalIds.length === 0) return null

  return withCursorHostStateLock(() => {
    const cursorDataDir = resolveCursorDataDir(input.env)
    const projectSlug = resolveCursorWorkspaceProjectSlug(input.cwd)
    const projectDir = join(cursorDataDir, 'projects', projectSlug)
    const approvalsPath = join(projectDir, 'mcp-approvals.json')

    mkdirSync(projectDir, { recursive: true })

    const existing = readApprovalIds(approvalsPath)
    const merged = [...existing]
    const seen = new Set(existing)
    for (const approvalId of approvalIds) {
      if (seen.has(approvalId)) continue
      seen.add(approvalId)
      merged.push(approvalId)
    }

    atomicWriteJson(approvalsPath, merged)
    return { approvalsPath }
  })
}

/**
 * P5: do not mutate the real project's `.cursor/cli.json`.
 * Kept as a no-op probe so callers can still log the path if needed.
 */
export function removeInvalidCursorCliConfig(workspaceRoot: string): {
  cliConfigPath: string
  removed: boolean
} {
  const cliConfigPath = join(workspaceRoot, '.cursor', 'cli.json')
  return { cliConfigPath, removed: false }
}
