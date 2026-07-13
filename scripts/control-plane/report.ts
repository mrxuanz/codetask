#!/usr/bin/env node
/**
 * Print last migration copy report summary.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/report.ts --report <report.json>
 */

import { parseArgs, readReport, requireArg, summarizeReport } from './migration-lib'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const reportPath = requireArg(args, 'report')
  const report = readReport(reportPath)
  console.log(summarizeReport(report))
}

main()
