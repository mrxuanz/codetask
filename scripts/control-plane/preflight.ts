#!/usr/bin/env node
/**
 * Migration preflight: open and validate an offline migration database.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/preflight.ts --db <path>
 */

import { parseArgs, requireArg } from './migration-lib'
import { runDatabasePreflight } from './migration-db'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const result = runDatabasePreflight(dbPath, {
    maintenanceMode: args.maintenance === true,
    schedulerStopped: args['scheduler-stopped'] === true,
    runtimeStopped: args['runtime-stopped'] === true,
    activeChildren: Number(typeof args['active-children'] === 'string' ? args['active-children'] : 0),
    ...(typeof args['user-version'] === 'string' ? { requiredUserVersion: Number(args['user-version']) } : {})
  })
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify(result, null, 2))
}

main()
