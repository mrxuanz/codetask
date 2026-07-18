#!/usr/bin/env node
/**
 * Promote a copied SQLite control plane to authoritative in one DB transaction.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/cutover.ts --db <app.db> --backup-id <id> --report <report.json> [--marker <audit.json>]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type CutoverMarker
} from './cutover-marker'
import { parseArgs, loadParseAndRehashReport, requireArg } from './migration-lib'
import { cutoverDatabase } from './migration-db'

function writeMarker(path: string, marker: CutoverMarker): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const backupId = requireArg(args, 'backup-id')
  const report = loadParseAndRehashReport(requireArg(args, 'report'))
  cutoverDatabase(dbPath, report, backupId)
  const auditPath = typeof args.marker === 'string' ? args.marker : null
  if (auditPath) {
    const audit: CutoverMarker = {
      key: 'control_schema_generation',
      value: 'v3_authoritative',
      sourceMigration: 27,
      copyReportHash: report.reportHash,
      backupId,
      updatedAtMs: Date.now()
    }
    writeMarker(auditPath, audit)
  }
  console.log(JSON.stringify({ ok: true, dbPath, reportHash: report.reportHash, backupId }, null, 2))
}

main()
