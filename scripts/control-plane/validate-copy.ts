#!/usr/bin/env node
/**
 * Validate copy report: count/hash checks; fail if conflicts.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/validate-copy.ts --report <report.json>
 */

import { parseArgs, readReport, requireArg, validateCopyReport } from './migration-lib'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const reportPath = requireArg(args, 'report')
  const report = readReport(reportPath)
  const result = validateCopyReport(report)
  console.log(
    JSON.stringify(
      {
        reportPath,
        ok: result.ok,
        errors: result.errors,
        hasConflicts: report.hasConflicts,
        reportHash: report.reportHash
      },
      null,
      2
    )
  )
  if (!result.ok) {
    process.exit(1)
  }
}

main()
