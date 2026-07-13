#!/usr/bin/env node
/**
 * Restore a DB file from backup (verifies .sha256 when present).
 *
 * Usage:
 *   node --import tsx scripts/control-plane/restore.ts --backup <backup> --out <db-path> [--sha256 <hex>]
 */

import { parseArgs, requireArg, restoreDatabase } from './migration-lib'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const backupPath = requireArg(args, 'backup')
  const out = requireArg(args, 'out')
  const expectedSha256 = typeof args.sha256 === 'string' ? args.sha256 : undefined
  if (expectedSha256) {
    restoreDatabase(backupPath, out, expectedSha256)
  } else {
    restoreDatabase(backupPath, out)
  }
  console.log(JSON.stringify({ ok: true, backupPath, out }, null, 2))
}

main()
