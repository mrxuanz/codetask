import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
}

describe('workspace configuration ownership', () => {
  it('legacy src/shared facade has been retired', () => {
    assert.equal(existsSync(join(root, 'src/shared')), false)
  })

  it('Service, Web, Desktop, and Tests own package and TypeScript configuration', () => {
    const expectedNames = new Map([
      ['apps/service', '@codetask/service'],
      ['apps/web', '@codetask/web'],
      ['apps/desktop', '@codetask/desktop'],
      ['tests', '@codetask/tests']
    ])

    for (const [directory, expectedName] of expectedNames) {
      const manifest = readJson(`${directory}/package.json`)
      const tsconfig = readJson(`${directory}/tsconfig.json`)
      assert.equal(manifest.name, expectedName)
      assert.equal(
        tsconfig.extends,
        directory === 'tests' ? '../tsconfig.base.json' : '../../tsconfig.base.json'
      )
    }
  })

  it('root TypeScript files are environment-neutral defaults and product tooling only', () => {
    const rootPackage = readJson('package.json')
    const base = readJson('tsconfig.base.json')
    const productTooling = readJson('tsconfig.json')

    assert.equal(rootPackage.type, 'module')
    assert.equal('include' in base, false)
    assert.deepEqual((base.compilerOptions as Record<string, unknown>).types, [])
    assert.equal(productTooling.extends, './tsconfig.base.json')
    assert.deepEqual(productTooling.include, ['electron.vite.config.*', 'build/**/*.ts'])
    for (const obsolete of [
      'tsconfig.node.json',
      'tsconfig.web.json',
      'tsconfig.browser-package.json'
    ]) {
      assert.equal(existsSync(join(root, obsolete)), false)
    }
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tsbuildinfo')),
      []
    )
  })

  it('every internal package workspace owns its TypeScript configuration', () => {
    for (const directory of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const workspaceRoot = join(root, 'packages', directory.name)
      if (!existsSync(join(workspaceRoot, 'package.json'))) continue

      assert.equal(existsSync(join(workspaceRoot, 'tsconfig.json')), true, directory.name)
      assert.equal(
        readJson(`packages/${directory.name}/tsconfig.json`).extends,
        '../../tsconfig.base.json',
        directory.name
      )
    }
  })

  it('internal packages declare direct cross-package and runtime dependencies', () => {
    const providerRuntime = readJson('packages/provider-runtime-node/package.json')
    const providerDependencies = providerRuntime.dependencies as Record<string, string>
    assert.equal(typeof providerDependencies['@codetask/provider-spec'], 'string')
    assert.equal(typeof providerDependencies['cross-spawn'], 'string')
    assert.equal(typeof providerDependencies.undici, 'string')
    assert.equal(typeof providerDependencies.zod, 'string')

    const testWorkspace = readJson('tests/package.json')
    const testDependencies = testWorkspace.devDependencies as Record<string, string>
    assert.equal(typeof testDependencies['cross-spawn'], 'string')
    assert.equal(typeof testDependencies['axe-core'], 'string')
    assert.equal(typeof testDependencies.jsdom, 'string')

    const contracts = readJson('packages/contracts/package.json')
    const contractExports = contracts.exports as Record<string, string>
    assert.equal(contractExports['./auth'], './src/auth.ts')

    const serverCore = readJson('packages/server-core/package.json')
    const serverDependencies = serverCore.dependencies as Record<string, string>
    assert.equal(typeof serverDependencies['@codetask/provider-spec'], 'string')
  })

  it('Desktop manifest remains a thin Electron shell', () => {
    const manifestText = readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
    assert.doesNotMatch(
      manifestText,
      /@codetask\/(?:agent-runtime|database|provider-runtime-node|server-core)/
    )
    assert.match(manifestText, /@codetask\/service-bootstrap/)
    assert.match(manifestText, /@electron-toolkit\/utils/)
  })

  it('Service configuration owns the host migration directories', () => {
    const config = readJson('apps/service/tsconfig.json')
    const include = config.include as string[]
    assert.ok(include.includes('../../src/server/**/*.ts'))
    assert.ok(include.includes('../../src/sandbox/**/*.ts'))
  })

  it('Service declares the dependencies used by its owned host sources', () => {
    const manifest = readJson('apps/service/package.json')
    const dependencies = manifest.dependencies as Record<string, string>
    for (const dependency of [
      '@codetask/agent-runtime',
      '@codetask/contracts',
      '@codetask/database',
      '@codetask/provider-runtime-node',
      '@codetask/provider-spec',
      '@codetask/server-core',
      '@codetask/service-bootstrap',
      '@hono/node-server',
      '@sinclair/typebox',
      'better-sqlite3',
      'drizzle-orm',
      'hono'
    ]) {
      assert.equal(typeof dependencies[dependency], 'string', dependency)
    }
  })

  it('Web owns its component generator configuration', () => {
    assert.equal(existsSync(join(root, 'components.json')), false)
    const components = readJson('apps/web/components.json')
    assert.equal((components.tailwind as Record<string, unknown>).css, 'src/assets/main.css')
  })

  it('root typecheck delegates directly to workspace-owned scripts', () => {
    const manifest = readJson('package.json')
    const scripts = manifest.scripts as Record<string, string>
    assert.deepEqual(
      Object.keys(scripts)
        .filter((name) => name.startsWith('typecheck'))
        .sort(),
      ['typecheck']
    )
    assert.match(scripts.typecheck, /npm run typecheck --workspaces --if-present/)
  })
})
