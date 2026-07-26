#!/usr/bin/env node
/**
 * Wave 9 cutover step 1: stop new task intake.
 *
 * Writes a cutover-lock file under the configurable data directory.
 * Downstream writers / operators treat the lock as "maintenance mode —
 * do not accept new jobs".
 *
 * Usage:
 *   node scripts/cutover/stop-intake.mjs --data-dir <path>
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import {
  cutoverLockPath,
  fail,
  parseArgs,
  printJson,
  resolveDataDir
} from './lib.mjs'

function main() {
  try {
    const args = parseArgs()
    const dataDir = resolveDataDir(args)
    mkdirSync(dataDir, { recursive: true })
    const lockPath = cutoverLockPath(dataDir)
    const payload = {
      locked: true,
      reason: 'cutover-stop-intake',
      createdAtMs: Date.now(),
      pid: process.pid
    }
    writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    printJson({ ok: true, step: 'stop-intake', dataDir, lockPath, ...payload })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
