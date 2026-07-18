#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const PRODUCT_NAME = 'codetask'
const PACKAGE_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).name
const READY_MARKER = 'CODETASK_SMOKE_READY '

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function findUnpackedRoot(distDir, platform) {
  const directories = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const candidates =
    platform === 'darwin'
      ? directories.filter((name) => name.startsWith('mac'))
      : directories.filter((name) => name.endsWith('-unpacked'))
  if (candidates.length !== 1) {
    throw new Error(`package_smoke.unpacked_ambiguous:${distDir}:${candidates.join(',')}`)
  }
  return join(distDir, candidates[0])
}

export function findExecutable(distDir, platform = process.platform) {
  const root = findUnpackedRoot(distDir, platform)
  if (platform === 'darwin') {
    const apps = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => entry.name)
      .sort()
    if (apps.length !== 1) throw new Error(`package_smoke.app_ambiguous:${root}:${apps.join(',')}`)
    const executable = join(root, apps[0], 'Contents', 'MacOS', PRODUCT_NAME)
    if (!existsSync(executable)) throw new Error(`package_smoke.executable_missing:${executable}`)
    return executable
  }

  const executableNames =
    platform === 'win32'
      ? [`${PRODUCT_NAME}.exe`]
      : // electron-builder defaults the Linux executable to package.json#name,
        // while productName controls the displayed product and artifact names.
        [PACKAGE_NAME, PRODUCT_NAME]
  const candidates = [...new Set(executableNames)]
    .map((name) => join(root, name))
    .filter((path) => existsSync(path))
  if (candidates.length === 0) {
    throw new Error(
      `package_smoke.executable_missing:${root}:expected=${executableNames.join(',')}:available=${readdirSync(root).sort().join(',')}`
    )
  }
  if (candidates.length > 1) {
    throw new Error(`package_smoke.executable_ambiguous:${root}:${candidates.join(',')}`)
  }
  return candidates[0]
}

export function runPackageSmoke(argv = process.argv) {
  const distDir = readArg(argv, '--dist')
  if (!distDir || !existsSync(distDir)) throw new Error('package_smoke.dist_required')

  const executable = findExecutable(distDir)
  const userDataDir = mkdtempSync(join(tmpdir(), 'codetask-package-smoke-'))
  const appArgs = ['--smoke-test', `--user-data-dir=${userDataDir}`]
  if (process.platform === 'linux') appArgs.push('--no-sandbox')

  try {
    const result = spawnSync(executable, appArgs, {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        CODETASK_SANDBOX_READY_MAX_ATTEMPTS: '1'
      }
    })
    if (result.error) throw result.error
    const marker = result.stdout.split(/\r?\n/u).find((line) => line.startsWith(READY_MARKER))
    if (result.status !== 0 || !marker) {
      throw new Error(
        `package_smoke.application_failed:${result.status}:stdout=${result.stdout}:stderr=${result.stderr}`
      )
    }
    const health = JSON.parse(marker.slice(READY_MARKER.length))
    console.log(JSON.stringify({ ok: true, executable: basename(executable), health }))
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPackageSmoke()
}
