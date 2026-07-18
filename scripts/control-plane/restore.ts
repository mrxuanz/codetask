#!/usr/bin/env node
/**
 * Restore a DB file from backup (verifies .sha256 when present).
 *
 * Usage:
 *   node --import tsx scripts/control-plane/restore.ts --backup <backup> --out <db-path> [--sha256 <hex>]
 */

import { parseArgs, requireArg } from './migration-lib'
import { restoreSqliteBackup } from './migration-db'

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const backupPath = requireArg(args, 'backup')
  const out = requireArg(args, 'out')
  const expectedSha256 = typeof args.sha256 === 'string' ? args.sha256 : undefined
  await restoreSqliteBackup(backupPath, out, expectedSha256)
  console.log(JSON.stringify({ ok: true, backupPath, out }, null, 2))
}

void main()
