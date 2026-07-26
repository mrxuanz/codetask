#!/usr/bin/env node
/**
 * Shared helpers for Wave 9 cutover runbook scripts.
 * These tools are for maintenance windows / fixture rehearsal only —
 * never point them at live user data unless operators explicitly intend cutover.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CUTOVER_LOCK_NAME = 'cutover.lock'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '../..')
export const TSX_TSCONFIG = join(REPO_ROOT, 'tests/tsx-tsconfig.mjs')

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i += 1
      } else {
        out[key] = true
      }
    } else {
      out._.push(token)
    }
  }
  return out
}

export function requireArg(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing required --${name}`)
  }
  return value.trim()
}

export function resolveDataDir(args) {
  const fromArg = typeof args['data-dir'] === 'string' ? args['data-dir'].trim() : ''
  const fromEnv = process.env.CODETASK_DATA_DIR?.trim() || ''
  const dataDir = fromArg || fromEnv
  if (!dataDir) {
    throw new Error('missing --data-dir (or CODETASK_DATA_DIR)')
  }
  return resolve(dataDir)
}

export function cutoverLockPath(dataDir) {
  return join(dataDir, CUTOVER_LOCK_NAME)
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

/**
 * Run a TypeScript module under the repo with tsx (for adapter / composition imports).
 */
export function runTsx(scriptRelativeToCutover, scriptArgs = []) {
  const scriptPath = join(HERE, scriptRelativeToCutover)
  if (!existsSync(scriptPath)) {
    throw new Error(`tsx runner missing: ${scriptPath}`)
  }
  const nodeArgs = []
  if (existsSync(TSX_TSCONFIG)) {
    nodeArgs.push('--import', TSX_TSCONFIG)
  }
  nodeArgs.push('--import', 'tsx', scriptPath, ...scriptArgs)
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    const err = new Error(
      `tsx runner failed (${scriptRelativeToCutover}): exit ${result.status ?? 'null'}`
    )
    err.status = result.status ?? 1
    throw err
  }
  return result
}

export function fail(message, code = 1) {
  console.error(message)
  process.exit(code)
}
