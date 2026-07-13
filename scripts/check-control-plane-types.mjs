#!/usr/bin/env node

/**
 * CI text gate: prevents unsafe type escapes in control-plane code.
 * Checks for: any, as unknown as, @ts-ignore, @ts-nocheck
 */

import { execSync } from 'child_process'
import { exit } from 'process'

const CONTROL_PLANE_DIRS = [
  'src/shared/contracts/control-plane',
  'src/server/domain',
  'src/server/application',
  'src/server/infra/sqlite/control-plane',
  'src/server/http/v3',
  'src/renderer/src/stores',
  'tests/control-plane'
]

const PATTERNS = [
  '\\bany\\b',
  'as unknown as',
  '@ts-ignore',
  '@ts-nocheck',
  'no-explicit-any'
]

function checkDirectory(dir) {
  try {
    const pattern = PATTERNS.join('|')
    const result = execSync(
      `rg -n "${pattern}" ${dir}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return result.trim()
  } catch (e) {
    // rg returns exit code 1 when no matches found
    if (e.status === 1) return ''
    throw e
  }
}

let hasErrors = false

for (const dir of CONTROL_PLANE_DIRS) {
  const matches = checkDirectory(dir)
  if (matches) {
    console.error(`\nUnsafe type escape found in ${dir}:`)
    console.error(matches)
    hasErrors = true
  }
}

if (hasErrors) {
  console.error('\n❌ unsafe type escape found in control-plane code')
  exit(1)
} else {
  console.log('✅ No unsafe type escapes found in control-plane code')
}
