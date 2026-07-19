#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLATFORMS = new Set([
  'linux-amd64',
  'linux-arm64',
  'macos-amd64',
  'macos-arm64',
  'windows-amd64',
  'windows-arm64'
])
const ARTIFACT_EXTENSIONS = ['.exe', '.deb', '.AppImage', '.dmg', '.zip']

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

export function normalizeReleaseArtifacts({ distDir, platform, version }) {
  if (!PLATFORMS.has(platform)) throw new Error(`release_artifacts.invalid_platform:${platform}`)
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
    throw new Error(`release_artifacts.invalid_version:${version}`)
  }
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const sourceArch = platform.endsWith('-amd64') ? 'x64' : 'arm64'
  const os = platform.split('-')[0]
  const sourcePrefix = `codetask-${packageJson.version}-${os}-${sourceArch}`
  const targetPrefix = `codetask-${version}-${platform}`
  const candidates = readdirSync(distDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(sourcePrefix) &&
        ARTIFACT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    )
    .map((entry) => entry.name)
    .sort()
  if (candidates.length === 0) {
    throw new Error(`release_artifacts.missing:${sourcePrefix}`)
  }

  const renamed = []
  for (const sourceName of candidates) {
    const targetName = `${targetPrefix}${sourceName.slice(sourcePrefix.length)}`
    if (sourceName !== targetName) {
      const target = join(distDir, targetName)
      if (existsSync(target)) throw new Error(`release_artifacts.target_exists:${targetName}`)
      renameSync(join(distDir, sourceName), target)
    }
    renamed.push(targetName)
  }
  return renamed
}

export function main(argv = process.argv.slice(2)) {
  const distDir = resolve(readArg(argv, '--dist') ?? 'dist')
  const platform = readArg(argv, '--platform')
  const version = readArg(argv, '--version')
  const artifacts = normalizeReleaseArtifacts({ distDir, platform, version })
  console.log(JSON.stringify({ ok: true, platform, version, artifacts }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
