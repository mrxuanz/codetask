#!/usr/bin/env node
/**
 * Wave 9 cutover step 8: open intake (remove cutover lock).
 *
 * Usage:
 *   node scripts/cutover/open-intake.mjs --data-dir <path>
 */

import { existsSync, unlinkSync } from 'node:fs'
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
    const lockPath = cutoverLockPath(dataDir)
    const existed = existsSync(lockPath)
    if (existed) {
      unlinkSync(lockPath)
    }
    printJson({
      ok: true,
      step: 'open-intake',
      dataDir,
      lockPath,
      removed: existed
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
