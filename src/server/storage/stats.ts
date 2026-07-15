import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import type Database from 'better-sqlite3'
import type { AppContext } from '../context'
import { dataPaths } from '../data-paths'

async function directoryBytes(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  const info = await stat(path).catch(() => null)
  if (!info) return 0
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue
    total += await directoryBytes(join(path, entry.name))
  }
  return total
}

function sqliteClient(ctx: AppContext): Database.Database | null {
  return (ctx.db as typeof ctx.db & { $client?: Database.Database }).$client ?? null
}

export async function readStorageStats(ctx: AppContext): Promise<{
  dataDir: string
  source: string
  managed: boolean
  bytes: {
    total: number
    database: number
    wal: number
    attachments: number
    artifacts: number
    runtimes: number
  }
  sqlite: { freelistPages: number; pageSize: number; reclaimableBytes: number }
}> {
  const paths = dataPaths(ctx.dataDir)
  const dbBytes = await directoryBytes(paths.dbFile)
  const walBytes = await directoryBytes(`${paths.dbFile}-wal`)
  const [attachments, messages, jobs, runtimes, total] = await Promise.all([
    directoryBytes(paths.attachments),
    directoryBytes(paths.artifactsMessages),
    directoryBytes(paths.artifactsJobs),
    directoryBytes(paths.runtimes),
    directoryBytes(ctx.dataDir)
  ])
  const sqlite = sqliteClient(ctx)
  const freelistPages = Number(sqlite?.pragma('freelist_count', { simple: true }) ?? 0)
  const pageSize = Number(sqlite?.pragma('page_size', { simple: true }) ?? 0)
  return {
    dataDir: ctx.dataDir,
    source: ctx.storage?.source ?? 'unknown',
    managed: ctx.storage?.managed ?? true,
    bytes: {
      total,
      database: dbBytes,
      wal: walBytes,
      attachments,
      artifacts: messages + jobs,
      runtimes
    },
    sqlite: { freelistPages, pageSize, reclaimableBytes: freelistPages * pageSize }
  }
}
