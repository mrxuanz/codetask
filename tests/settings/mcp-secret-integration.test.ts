import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import {
  buildClaudeMcpServers,
  buildCodexSdkConfig,
  buildCursorAcpMcpServers,
  buildOpencodeMcpServers
} from '../../src/server/agent-runtime/mcp'
import { toAcpMcpServers } from '../../src/server/agent-runtime/cursor-acp/acp-shared'
import {
  defaultUserMcpSettings,
  loadUserMcpSettings,
  redactUserMcpSettings,
  resolveUserMcpServersMap,
  saveUserMcpSettings
} from '../../src/server/settings/mcp'

test('encrypted MCP secrets reach every SDK and ACP provider config', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-mcp-bootstrap-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(root, { recursive: true, force: true })
  })
  const dataDir = join(root, 'data')
  const bootstrapRoot = join(root, 'bootstrap-root')
  const vaultPath = join(bootstrapRoot, 'secrets', 'mcp-secrets.json')
  const userMcp = defaultUserMcpSettings()
  userMcp.conversation['claude-code'].mcpServers = {
    docs: {
      type: 'http',
      url: 'https://claude.example/mcp',
      headers: { Authorization: 'Bearer claude-secret', Accept: 'application/json' }
    }
  }
  userMcp.conversation.codex.mcp_servers = {
    docs: {
      url: 'https://codex.example/mcp',
      http_headers: { Authorization: 'Bearer codex-secret' }
    }
  }
  userMcp.conversation.cursorcli.mcpServers = {
    remote: {
      url: 'https://cursor.example/mcp',
      headers: { Authorization: 'Bearer cursor-secret' }
    },
    local: {
      command: 'cursor-mcp',
      args: ['--stdio'],
      env: { CURSOR_TOKEN: 'cursor-env-secret', PUBLIC_VALUE: 'visible' }
    }
  }
  userMcp.conversation.opencode.mcp = {
    docs: {
      type: 'remote',
      url: 'https://opencode.example/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer opencode-secret' }
    },
    local: {
      type: 'local',
      command: ['opencode-mcp', '--stdio'],
      enabled: true,
      environment: { OPENCODE_TOKEN: 'opencode-env-secret', PUBLIC_VALUE: 'visible' }
    }
  }
  const ctx = bootstrapRuntime({
    dataDir,
    mode: 'desktop',
    authSecret: 'e'.repeat(64),
    mcpSecretPath: vaultPath,
    storage: { bootstrapRoot, source: 'test', managed: false }
  })
  saveUserMcpSettings(userMcp)

  const persisted = ctx.settings.read().userMcp as Record<string, unknown>
  const secretValues = [
    'claude-secret',
    'codex-secret',
    'cursor-secret',
    'cursor-env-secret',
    'opencode-secret',
    'opencode-env-secret'
  ]
  const persistedJson = JSON.stringify(persisted)
  const vaultJson = readFileSync(vaultPath, 'utf8')
  for (const secret of secretValues) {
    assert.equal(persistedJson.includes(secret), false)
    assert.equal(vaultJson.includes(secret), false)
  }
  assert.match(JSON.stringify(persisted), /\$\{secret:[0-9a-f-]{36}\}/)
  assert.equal(existsSync(vaultPath), true)

  const resolvedClaude = resolveUserMcpServersMap('claude-code', 'conversation')
  const resolvedCodex = resolveUserMcpServersMap('codex', 'conversation')
  const resolvedCursor = resolveUserMcpServersMap('cursorcli', 'conversation')
  const resolvedOpencode = resolveUserMcpServersMap('opencode', 'conversation')
  assert.deepEqual(resolvedClaude, userMcp.conversation['claude-code'].mcpServers)
  assert.deepEqual(resolvedCodex, userMcp.conversation.codex.mcp_servers)
  assert.deepEqual(resolvedCursor, userMcp.conversation.cursorcli.mcpServers)
  assert.deepEqual(resolvedOpencode, userMcp.conversation.opencode.mcp)

  const codexConfig = buildCodexSdkConfig({
    mcpUrl: 'http://127.0.0.1:3000/api/mcp/task/system',
    userMcpServers: resolvedCodex
  })
  assert.deepEqual(codexConfig?.mcp_servers.docs, resolvedCodex.docs)
  assert.ok(codexConfig?.mcp_servers['codeteam-manager'])
  assert.deepEqual(buildClaudeMcpServers(undefined, resolvedClaude), resolvedClaude)
  assert.deepEqual(buildOpencodeMcpServers(undefined, resolvedOpencode), resolvedOpencode)

  const cursorPlan = buildCursorAcpMcpServers(
    'http://127.0.0.1:3000/api/mcp/task/system',
    resolvedCursor
  )
  const cursorRemote = cursorPlan.find((server) => server.name === 'remote')
  const cursorLocal = cursorPlan.find((server) => server.name === 'local')
  const cursorSystem = cursorPlan.find((server) => server.name === 'codeteam-manager')
  assert.deepEqual(cursorRemote?.headers, [
    { name: 'Authorization', value: 'Bearer cursor-secret' }
  ])
  assert.equal(cursorLocal?.env?.CURSOR_TOKEN, 'cursor-env-secret')
  assert.equal(cursorSystem?.url, 'http://127.0.0.1:3000/api/mcp/task/system')

  const acpServers = toAcpMcpServers(cursorPlan)
  const acpRemote = acpServers.find((server) => server.name === 'remote')
  const acpLocal = acpServers.find((server) => server.name === 'local')
  const acpSystem = acpServers.find((server) => server.name === 'codeteam-manager')
  assert.deepEqual('headers' in (acpRemote ?? {}) ? acpRemote.headers : undefined, [
    { name: 'Authorization', value: 'Bearer cursor-secret' }
  ])
  assert.deepEqual('env' in (acpLocal ?? {}) ? acpLocal.env : undefined, [
    { name: 'CURSOR_TOKEN', value: 'cursor-env-secret' },
    { name: 'PUBLIC_VALUE', value: 'visible' }
  ])
  assert.equal('url' in (acpSystem ?? {}) ? acpSystem.url : undefined, cursorSystem?.url)

  const masked = redactUserMcpSettings(loadUserMcpSettings())
  const saved = saveUserMcpSettings(masked)
  for (const secret of secretValues) assert.equal(JSON.stringify(saved).includes(secret), false)
  assert.deepEqual(resolveUserMcpServersMap('codex', 'conversation'), resolvedCodex)
  assert.deepEqual(resolveUserMcpServersMap('cursorcli', 'conversation'), resolvedCursor)
  assert.deepEqual(resolveUserMcpServersMap('opencode', 'conversation'), resolvedOpencode)
})
