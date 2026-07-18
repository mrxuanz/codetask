#!/usr/bin/env node

/**
 * CI text gate: flags `as unknown as` double assertions in production source.
 * Prefer type guards or schema validators instead of double casts.
 */

import { execSync } from 'child_process'
import { exit } from 'process'

const SCAN_DIRS = ['src']

const PATTERN = 'as unknown as'

function checkDirectory(dir) {
  try {
    const result = execSync(`rg -n "${PATTERN}" ${dir}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return result.trim()
  } catch (e) {
    if (e.status === 1) return ''
    throw e
  }
}

let hasErrors = false

for (const dir of SCAN_DIRS) {
  const matches = checkDirectory(dir)
  if (matches) {
    console.error(`\nDouble assertion found in ${dir}:`)
    console.error(matches)
    hasErrors = true
  }
}

if (hasErrors) {
  console.error('\n❌ as unknown as double assertions found in src/')
  exit(1)
} else {
  console.log('✅ No as unknown as double assertions found in src/')
}
