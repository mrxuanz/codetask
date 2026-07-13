#!/usr/bin/env node
/**
 * Consistent file-DB backup with sha256 sidecar.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/backup.ts --db <path> --out <backup-path>
 */

import { parseArgs, requireArg } from './migration-lib'
import { backupSqliteDatabase } from './migration-db'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const out = requireArg(args, 'out')
  const result = await backupSqliteDatabase(dbPath, out)
  console.log(JSON.stringify(result, null, 2))
}

void main()
