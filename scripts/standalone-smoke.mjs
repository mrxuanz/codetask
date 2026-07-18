#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const READY_MARKER = 'CODETASK_SMOKE_READY '

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

export function runStandaloneSmoke(argv = process.argv) {
  const configuredEntry = readArg(argv, '--entry')
  if (!configuredEntry) throw new Error('standalone_smoke.entry_required')

  const entry = resolve(configuredEntry)
  if (!existsSync(entry)) throw new Error(`standalone_smoke.entry_missing:${entry}`)

  const root = mkdtempSync(join(tmpdir(), 'codetask-standalone-smoke-'))
  try {
    const env = { ...process.env }
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
    env.CODETASK_BOOTSTRAP_ROOT = join(root, 'bootstrap')
    env.CODETASK_SANDBOX_READY_MAX_ATTEMPTS = '1'

    const result = spawnSync(
      process.execPath,
      [entry, '--smoke-test', '--data-dir', join(root, 'data')],
      {
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        env
      }
    )
    if (result.error) throw result.error

    const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(READY_MARKER))
    if (result.status !== 0 || !marker) {
      throw new Error(
        `standalone_smoke.application_failed:${result.status}:stdout=${result.stdout}:stderr=${result.stderr}`
      )
    }

    const health = JSON.parse(marker.slice(READY_MARKER.length))
    console.log(JSON.stringify({ ok: true, entry, display: 'unset', health }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStandaloneSmoke()
}
