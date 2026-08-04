#!/usr/bin/env node
/**
 * Database / attachment integrity audit (Batch B / Phase 0).
 *
 * Usage:
 *   node scripts/db-integrity-audit.mjs --db /path/to/app.db
 *   node scripts/db-integrity-audit.mjs --data-dir /path/to/data
 *
 * Prints JSON:
 *   schemaVersion, tables[{name,rowCount}], foreignKeyViolations,
 *   attachmentOwnerDirs{orphanCount,missingCount,orphanIds,missingSample}
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { db: null, dataDir: null }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') out.db = argv[++i]
    else if (arg === '--data-dir') out.dataDir = argv[++i]
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name)
  return Boolean(row)
}

export function auditDatabase(db, options = {}) {
  const dataDir = options.dataDir ?? null
  const versionRow = db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get()
  const schemaVersion = versionRow?.version ?? 0

  const tableNames = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((r) => r.name)

  const tables = tableNames.map((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { name, rowCount: -1 }
    }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()
    return { name, rowCount: Number(row.n) }
  })

  const foreignKeyViolations = db.prepare(`PRAGMA foreign_key_check`).all()

  const validOwners = new Set()
  if (tableExists(db, 'threads')) {
    for (const row of db.prepare(`SELECT id FROM threads`).all()) {
      validOwners.add(String(row.id))
    }
  }
  if (tableExists(db, 'conversation_threads')) {
    for (const row of db.prepare(`SELECT id FROM conversation_threads`).all()) {
      validOwners.add(String(row.id))
    }
  }
  if (tableExists(db, 'asset_references')) {
    for (const row of db
      .prepare(
        `SELECT DISTINCT owner_id AS ownerId FROM asset_references
          WHERE owner_type IN ('conversation', 'thread')`
      )
      .all()) {
      validOwners.add(String(row.ownerId))
    }
  }

  let orphanCount = 0
  let missingCount = 0
  const orphanIds = []
  const missingSample = []

  if (dataDir) {
    const attachmentsRoot = join(dataDir, 'assets', 'attachments')
    const onDisk = new Set()
    if (existsSync(attachmentsRoot)) {
      for (const entry of readdirSync(attachmentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        onDisk.add(entry.name)
        if (!validOwners.has(entry.name)) {
          orphanCount += 1
          if (orphanIds.length < 50) orphanIds.push(entry.name)
        }
      }
    }
    for (const ownerId of validOwners) {
      if (!onDisk.has(ownerId)) {
        // Missing dirs are normal until first attachment upload; only report as sample.
        missingCount += 1
        if (missingSample.length < 20) missingSample.push(ownerId)
      }
    }
  }

  let pendingDeleteAssets = 0
  if (tableExists(db, 'assets')) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE state = 'pending_delete'`).get()
    pendingDeleteAssets = Number(row?.n ?? 0)
  }

  const deadTablesPresent = ['conversation_outbox', 'agent_runtime_bindings'].filter((name) =>
    tableExists(db, name)
  )

  return {
    schemaVersion,
    tables,
    foreignKeyViolations,
    attachmentOwnerDirs: {
      orphanCount,
      missingCount,
      orphanIds,
      missingSample
    },
    assets: {
      pendingDeleteAssets,
      deadTablesPresent
    }
  }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help || (!args.db && !args.dataDir)) {
    console.error('Usage: node scripts/db-integrity-audit.mjs --db <app.db> | --data-dir <dataDir>')
    process.exit(args.help ? 0 : 2)
  }

  const dbPath = args.db ?? join(args.dataDir, 'db', 'app.db')
  if (!existsSync(dbPath)) {
    console.error(JSON.stringify({ error: 'db_not_found', dbPath }, null, 2))
    process.exit(1)
  }

  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys = ON')
    const dataDir =
      args.dataDir ??
      (dbPath.endsWith(`${join('db', 'app.db')}`) || dbPath.endsWith('db/app.db')
        ? join(dbPath, '..', '..')
        : null)
    const report = auditDatabase(db, { dataDir })
    console.log(JSON.stringify(report, null, 2))
    if (report.foreignKeyViolations.length > 0 || report.attachmentOwnerDirs.orphanCount > 0) {
      process.exitCode = 3
    }
  } finally {
    db.close()
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('db-integrity-audit.mjs') ||
    process.argv[1].includes('db-integrity-audit'))

if (isDirectRun) {
  main()
}
