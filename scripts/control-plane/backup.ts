#!/usr/bin/env node
/**
 * Consistent file-DB backup with sha256 sidecar.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/backup.ts --db <path> --out <backup-path>
 */

import { backupDatabase, parseArgs, requireArg } from './migration-lib'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const out = requireArg(args, 'out')
  const result = backupDatabase(dbPath, out)
  console.log(JSON.stringify(result, null, 2))
}

main()
