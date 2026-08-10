#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SUPPORTED_PLATFORMS = new Set([
  'linux-amd64',
  'linux-arm64',
  'macos-amd64',
  'macos-arm64',
  'windows-amd64',
  'windows-arm64'
])

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `release_signing.verify_failed:${command}:${result.status}:stdout=${result.stdout}:stderr=${result.stderr}`
    )
  }
  return `${result.stdout}${result.stderr}`.trim()
}

function findSingleDirectory(distDir, predicate, label) {
  const matches = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(entry.name))
    .map((entry) => join(distDir, entry.name))
    .sort()
  if (matches.length !== 1) {
    throw new Error(`release_signing.${label}_ambiguous:${matches.join(',')}`)
  }
  return matches[0]
}

function verifyMac(distDir) {
  const unpacked = findSingleDirectory(distDir, (name) => name.startsWith('mac'), 'mac_root')
  const app = findSingleDirectory(unpacked, (name) => name.endsWith('.app'), 'mac_app')
  const executable = join(app, 'Contents', 'MacOS', 'codetask')
  if (!existsSync(executable))
    throw new Error(`release_signing.mac_executable_missing:${executable}`)

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const details = run('codesign', ['--display', '--verbose=4', app])
  if (!/Authority=Developer ID Application:/u.test(details)) {
    throw new Error('release_signing.mac_developer_id_missing')
  }
  run('spctl', ['--assess', '--verbose=4', '--type', 'exec', app])
  run('xcrun', ['stapler', 'validate', app])
  return { targets: [basename(app)], authority: 'Developer ID Application', notarized: true }
}

function verifyWindows(distDir, platform) {
  const publicExecutables = readdirSync(distDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.includes(`-${platform}`) &&
        entry.name.toLowerCase().endsWith('.exe')
    )
    .map((entry) => resolve(distDir, entry.name))
    .sort()
  const unpacked = findSingleDirectory(distDir, (name) => name.endsWith('-unpacked'), 'win_root')
  const unpackedExecutable = join(unpacked, 'codetask.exe')
  if (existsSync(unpackedExecutable)) publicExecutables.push(unpackedExecutable)
  if (publicExecutables.length === 0) throw new Error('release_signing.windows_executable_missing')

  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$paths = ConvertFrom-Json $env:CODETASK_SIGNATURE_PATHS',
    'foreach ($path in $paths) {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $path',
    '  if ($signature.Status -ne \'Valid\') { throw "Invalid Authenticode signature: $path ($($signature.Status))" }',
    '}'
  ].join('; ')
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CODETASK_SIGNATURE_PATHS: JSON.stringify(publicExecutables) }
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `release_signing.authenticode_invalid:${result.status}:stdout=${result.stdout}:stderr=${result.stderr}`
    )
  }
  return { targets: publicExecutables.map((path) => basename(path)), authenticode: 'Valid' }
}

export function verifyReleaseSigning({ distDir, platform }) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`release_signing.invalid_platform:${platform}`)
  }
  if (!existsSync(distDir)) throw new Error(`release_signing.dist_missing:${distDir}`)
  if (platform.startsWith('linux-')) {
    return { ok: true, platform, signing: 'not-required', targets: [] }
  }
  const proof = platform.startsWith('macos-')
    ? verifyMac(distDir)
    : verifyWindows(distDir, platform)
  return { ok: true, platform, signing: 'verified', ...proof }
}

export function main(argv = process.argv.slice(2)) {
  const distDir = resolve(readArg(argv, '--dist') ?? 'dist')
  const platform = readArg(argv, '--platform') ?? ''
  console.log(JSON.stringify(verifyReleaseSigning({ distDir, platform })))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
