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

// electron-builder's ${arch} is remapped per target via getArtifactArchName():
// Linux x64 AppImage → x86_64, Linux x64 deb → amd64, Win/mac x64 → x64.
function sourceArchTokens(platform) {
  switch (platform) {
    case 'linux-amd64':
      return ['x86_64', 'amd64', 'x64']
    case 'linux-arm64':
      return ['arm64', 'aarch64']
    case 'macos-amd64':
    case 'windows-amd64':
      return ['x64']
    case 'macos-arm64':
    case 'windows-arm64':
      return ['arm64']
    default:
      throw new Error(`release_artifacts.invalid_platform:${platform}`)
  }
}

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
  const os = platform.split('-')[0]
  const targetPrefix = `codetask-${version}-${platform}`
  const sourcePrefixes = sourceArchTokens(platform).map(
    (arch) => `codetask-${packageJson.version}-${os}-${arch}`
  )
  const files = readdirSync(distDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && ARTIFACT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    )
    .map((entry) => entry.name)

  const matched = []
  for (const sourceName of files) {
    const sourcePrefix = sourcePrefixes.find((prefix) => sourceName.startsWith(prefix))
    if (!sourcePrefix) continue
    matched.push({ sourceName, sourcePrefix })
  }
  matched.sort((left, right) => left.sourceName.localeCompare(right.sourceName))
  if (matched.length === 0) {
    throw new Error(`release_artifacts.missing:${sourcePrefixes.join('|')}`)
  }

  const renamed = []
  for (const { sourceName, sourcePrefix } of matched) {
    const targetName = `${targetPrefix}${sourceName.slice(sourcePrefix.length)}`
    if (sourceName !== targetName) {
      const target = join(distDir, targetName)
      if (existsSync(target)) throw new Error(`release_artifacts.target_exists:${targetName}`)
      renameSync(join(distDir, sourceName), target)
    }
    renamed.push(targetName)
  }
  return renamed.sort()
}

export function main(argv = process.argv.slice(2)) {
  const distDir = resolve(readArg(argv, '--dist') ?? 'dist')
  const platform = readArg(argv, '--platform')
  const version = readArg(argv, '--version')
  const artifacts = normalizeReleaseArtifacts({ distDir, platform, version })
  console.log(JSON.stringify({ ok: true, platform, version, artifacts }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
