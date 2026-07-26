/**
 * Thin TS entry for data validator (spawned by validate.mjs).
 *
 * Usage (via wrapper):
 *   node scripts/cutover/validate.mjs --db <core.db>
 */

import Database from 'better-sqlite3'
import { validateCoreDb } from '../../src/server/adapters/sqlite/index.ts'

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function requireArg(args: Record<string, string | true>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing required --${name}`)
  }
  return value.trim()
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const report = validateCoreDb(db)
    const payload = {
      ok: report.ok,
      step: 'validate',
      dbPath,
      totalOrphans: report.totalOrphans,
      orphans: report.orphans
    }
    console.log(JSON.stringify(payload, null, 2))
    if (!report.ok) {
      process.exitCode = 2
    }
  } finally {
    db.close()
  }
}

main()
