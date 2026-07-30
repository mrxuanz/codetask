#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const READY_MARKER = 'CODETASK_SMOKE_READY '

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

export function runStandaloneSmoke(argv = process.argv) {
  const descriptorPath = readArg(argv, '--descriptor')
  const descriptor = descriptorPath
    ? JSON.parse(readFileSync(resolve(descriptorPath), 'utf8'))
    : undefined
  const configuredEntry = readArg(argv, '--entry') ?? descriptor?.executable
  const executableMode = argv.includes('--executable') || Boolean(descriptor)
  if (!configuredEntry) throw new Error('standalone_smoke.entry_required')

  const entry = resolve(configuredEntry)
  if (!existsSync(entry)) throw new Error(`standalone_smoke.entry_missing:${entry}`)

  const root = mkdtempSync(join(tmpdir(), 'codetask-standalone-smoke-'))
  const configPath = executableMode
    ? join(dirname(entry), 'codetask-data.json')
    : join(process.cwd(), 'codetask-data.json')
  const previousConfig = existsSync(configPath) ? readFileSync(configPath) : null
  try {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          formatVersion: 1,
          installationId: randomUUID(),
          createdAt: new Date().toISOString(),
          dbPath: join(root, 'data', 'db', 'app.db')
        },
        null,
        2
      )}\n`
    )
    const env = { ...process.env }
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
    env.CODETASK_SANDBOX_READY_MAX_ATTEMPTS = '1'

    const result = spawnSync(
      executableMode ? entry : process.execPath,
      executableMode ? ['--smoke-test'] : [entry, '--smoke-test'],
      {
        cwd: executableMode ? resolve(entry, '..', '..') : undefined,
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
    console.log(
      JSON.stringify({
        ok: true,
        entry,
        mode: executableMode ? 'sea' : 'node',
        display: 'unset',
        health
      })
    )
  } finally {
    if (previousConfig) writeFileSync(configPath, previousConfig)
    else rmSync(configPath, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStandaloneSmoke()
}
