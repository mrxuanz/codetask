import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'

function buildOuterSandboxCodexConfigOverrides() {
  return {
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    sandbox_workspace_write: { network_access: true }
  }
}

function buildCodexSdkConfig(input) {
  const config = {}
  if (input.mcpUrl) {
    config.mcp_servers = {
      'codeteam-manager': { url: input.mcpUrl }
    }
  }
  if (input.outerSandbox) {
    Object.assign(config, buildOuterSandboxCodexConfigOverrides())
  }
  const hasMcp = Boolean(config.mcp_servers && Object.keys(config.mcp_servers).length > 0)
  const hasOuterOverrides = Boolean(input.outerSandbox)
  if (!hasMcp && !hasOuterOverrides) return undefined
  return config
}

function resolveCodexCliBin() {
  try {
    const require = createRequire(import.meta.url)
    const codexPackageJson = require.resolve('@openai/codex/package.json')
    const codexBin = join(dirname(codexPackageJson), 'bin', 'codex.js')
    return existsSync(codexBin) ? codexBin : null
  } catch {
    return null
  }
}

function runCodexMcpList(codexHome, extraArgs = []) {
  const codexBin = resolveCodexCliBin()
  if (!codexBin) return null
  return spawnSync(process.execPath, [codexBin, 'mcp', 'list', ...extraArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    },
    encoding: 'utf8'
  })
}

test('buildCodexSdkConfig merges outer-sandbox CLI-safe overrides', () => {
  const config = buildCodexSdkConfig({ outerSandbox: true, mcpUrl: 'http://127.0.0.1:1/mcp' })
  assert.equal(config.sandbox_mode, 'danger-full-access')
  assert.equal(config.approval_policy, 'never')
  assert.deepEqual(config.sandbox_workspace_write, { network_access: true })
  assert.equal(config.mcp_servers['codeteam-manager'].url, 'http://127.0.0.1:1/mcp')
})

test('buildCodexSdkConfig returns overrides without mcp when outer sandbox only', () => {
  const config = buildCodexSdkConfig({ outerSandbox: true })
  assert.equal(config.sandbox_mode, 'danger-full-access')
  assert.equal(config.approval_policy, 'never')
  assert.deepEqual(config.sandbox_workspace_write, { network_access: true })
})

test('buildCodexSdkConfig skips overrides off outer sandbox path', () => {
  assert.equal(buildCodexSdkConfig({ mcpUrl: 'http://127.0.0.1:1/mcp' }).sandbox_mode, undefined)
  assert.equal(buildCodexSdkConfig({}), undefined)
})

test('Codex CLI accepts SDK sandbox_mode override over stale host config', (t) => {
  const runtimesRoot = join(process.cwd(), 'data', 'runtimes')
  mkdirSync(runtimesRoot, { recursive: true })
  const codexHome = mkdtempSync(join(runtimesRoot, '_codex-sdk-config-'))
  t.after(() => rmSync(codexHome, { recursive: true, force: true }))

  writeFileSync(join(codexHome, 'config.toml'), 'sandbox_mode = "external-sandbox"\n', 'utf8')

  const failed = runCodexMcpList(codexHome)
  if (!failed) {
    t.skip('@openai/codex CLI is not installed')
    return
  }
  assert.notEqual(failed.status, 0)
  assert.match(`${failed.stdout}\n${failed.stderr}`, /external-sandbox/)

  const passed = runCodexMcpList(codexHome, ['--config', 'sandbox_mode="danger-full-access"'])
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`)
})
