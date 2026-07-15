import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import {
  defaultUserMcpSettings,
  loadUserMcpSettings,
  redactUserMcpSettings,
  resolveUserMcpServersMap,
  saveUserMcpSettings
} from '../../src/server/settings/mcp'

test('new MCP settings store references and resolve only in the trusted parent', async (t) => {
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
      headers: { Authorization: 'Bearer app-secret', Accept: 'application/json' },
      env: { DOCS_TOKEN: 'app-env-secret', PUBLIC_VALUE: 'visible' }
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
  assert.equal(JSON.stringify(persisted).includes('app-secret'), false)
  assert.match(JSON.stringify(persisted), /\$\{secret:[0-9a-f-]{36}\}/)
  assert.equal(existsSync(vaultPath), true)
  assert.equal(readFileSync(vaultPath, 'utf8').includes('app-secret'), false)

  const resolved = resolveUserMcpServersMap('claude-code', 'conversation')
  assert.deepEqual(resolved, userMcp.conversation['claude-code'].mcpServers)

  const masked = redactUserMcpSettings(loadUserMcpSettings())
  const saved = saveUserMcpSettings(masked)
  assert.equal(JSON.stringify(saved).includes('app-secret'), false)
  assert.deepEqual(
    resolveUserMcpServersMap('claude-code', 'conversation'),
    userMcp.conversation['claude-code'].mcpServers
  )
})
