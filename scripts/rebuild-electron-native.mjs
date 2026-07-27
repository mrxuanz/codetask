import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPackage = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
)
const electronVersion = String(electronPackage.version)
const nodeGyp = join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const moduleRoot = join(root, 'node_modules', 'better-sqlite3')
const devDir = join(root, '.cache', 'electron-gyp')
const stagingRoot = join(root, '.cache', 'electron-native-staging', 'better-sqlite3')
const stagingParent = dirname(stagingRoot)
const stagedBuild = join(stagingRoot, 'build', 'Release', 'better_sqlite3.node')
const installedBuild = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node')

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingParent, { recursive: true })
cpSync(moduleRoot, stagingRoot, {
  recursive: true,
  filter(source) {
    return source !== join(moduleRoot, 'build')
  }
})

const result = spawnSync(
  process.execPath,
  [
    nodeGyp,
    'rebuild',
    '--runtime=electron',
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    '--dist-url=https://electronjs.org/headers',
    `--devdir=${devDir}`,
    '--build-from-source'
  ],
  {
    cwd: stagingRoot,
    stdio: 'inherit'
  }
)

if ((result.status ?? 1) !== 0) {
  rmSync(stagingRoot, { recursive: true, force: true })
  console.error('[native] Electron rebuild failed; the installed Node ABI binary was preserved.')
  process.exit(result.status ?? 1)
}
if (!existsSync(stagedBuild)) {
  rmSync(stagingRoot, { recursive: true, force: true })
  console.error(`[native] Electron rebuild produced no binary at ${stagedBuild}`)
  process.exit(1)
}

mkdirSync(dirname(installedBuild), { recursive: true })
copyFileSync(stagedBuild, installedBuild)
rmSync(stagingRoot, { recursive: true, force: true })
console.log(`[native] installed better-sqlite3 for Electron ${electronVersion}`)
