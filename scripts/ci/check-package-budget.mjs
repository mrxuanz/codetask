import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPackage } from '@electron/asar'

const MIB = 1024 * 1024
export const PACKAGE_BUDGETS = Object.freeze({
  rendererJavaScriptBytes: 1 * MIB,
  asarBytes: 128 * MIB,
  asarUnpackedBytes: 700 * MIB,
  // Logical size counts APFS-cloned Electron Framework files more than once;
  // the current macOS package is ~892 MiB on disk and ~1.32 GiB logically.
  packagedApplicationBytes: 1500 * MIB,
  dependencyNoiseFiles: 0
})

function walk(path, visit, seenFiles = new Set(), allocatedSize = false) {
  const stat = statSync(path)
  if (!stat.isDirectory()) {
    const identity = `${stat.dev}:${stat.ino}`
    if (stat.nlink > 1 && seenFiles.has(identity)) return 0
    seenFiles.add(identity)
    visit(path, stat.size)
    return allocatedSize && process.platform === 'darwin' ? stat.blocks * 512 : stat.size
  }
  let total = 0
  for (const entry of readdirSync(path)) {
    total += walk(join(path, entry), visit, seenFiles, allocatedSize)
  }
  return total
}

export function resolveUnpackedPackagePath(distDir, platform = process.platform) {
  const directories = readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (platform === 'darwin') {
    const apps = directories
      .filter((name) => name.startsWith('mac'))
      .flatMap((name) =>
        readdirSync(join(distDir, name), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
          .map((entry) => join(distDir, name, entry.name))
      )
    if (apps.length === 1) return apps[0]
    throw new Error(`package_budget.app_ambiguous:${distDir}:${apps.join(',')}`)
  }
  const unpacked = directories.filter((name) => name.endsWith('-unpacked'))
  if (unpacked.length === 1) return join(distDir, unpacked[0])
  throw new Error(`package_budget.unpacked_ambiguous:${distDir}:${unpacked.join(',')}`)
}

export function measurePackage(packagePath, rendererPath = 'out/renderer') {
  let noiseFiles = 0
  const packagedApplicationBytes = walk(
    packagePath,
    (path) => {
      if (
        /node_modules[/\\].*[/\\](?:tests?|__tests__|examples?)[/\\]/i.test(path) ||
        /\.(?:map|ts)$/i.test(path)
      ) {
        noiseFiles += 1
      }
    },
    new Set(),
    true
  )
  const resources = packagePath.endsWith('.app')
    ? join(packagePath, 'Contents', 'Resources')
    : join(packagePath, 'resources')
  const asarPath = join(resources, 'app.asar')
  const unpackedPath = join(resources, 'app.asar.unpacked')
  let rendererJavaScriptBytes = 0
  if (existsSync(rendererPath)) {
    walk(rendererPath, (path, size) => {
      if (/\.js$/i.test(path)) rendererJavaScriptBytes = Math.max(rendererJavaScriptBytes, size)
    })
  }
  if (existsSync(asarPath)) {
    for (const path of listPackage(asarPath)) {
      if (
        /node_modules[/\\].*[/\\](?:tests?|__tests__|examples?)[/\\]/i.test(path) ||
        /\.(?:map|ts)$/i.test(path)
      ) {
        noiseFiles += 1
      }
    }
  }
  return {
    rendererJavaScriptBytes,
    asarBytes: existsSync(asarPath) ? statSync(asarPath).size : 0,
    asarUnpackedBytes: existsSync(unpackedPath) ? walk(unpackedPath, () => {}, new Set(), true) : 0,
    packagedApplicationBytes,
    dependencyNoiseFiles: noiseFiles
  }
}

export function assertPackageBudgets(metrics, budgets = PACKAGE_BUDGETS) {
  const failures = Object.entries(budgets)
    .filter(([key, maximum]) => metrics[key] > maximum)
    .map(([key, maximum]) => `${key}: ${metrics[key]} > ${maximum}`)
  if (failures.length) throw new Error(`Package budget exceeded:\n${failures.join('\n')}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const distIndex = process.argv.indexOf('--dist')
  const packagePath =
    distIndex >= 0 && process.argv[distIndex + 1]
      ? resolveUnpackedPackagePath(process.argv[distIndex + 1])
      : process.argv[2]
  if (!packagePath || !existsSync(packagePath)) {
    throw new Error(
      'Usage: node scripts/ci/check-package-budget.mjs <unpacked-app-path> | --dist <dist-path>'
    )
  }
  const metrics = measurePackage(packagePath)
  assertPackageBudgets(metrics)
  console.log(`Package budgets passed for ${basename(packagePath)}: ${JSON.stringify(metrics)}`)
}
