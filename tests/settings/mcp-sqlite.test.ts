import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type Database from 'better-sqlite3'
import {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import {
  cliMcpRootKey,
  defaultUserMcpSettings,
  loadUserMcpSettings,
  saveUserMcpSettings
} from '../../src/server/settings/mcp'

test('MCP configuration is stored directly in SQLite without a secret vault', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-mcp-sqlite-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  bootstrapRuntime({ dataDir })

  const settings = defaultUserMcpSettings()
  const rootKey = cliMcpRootKey('codex')
  settings.conversation.codex[rootKey] = {
    docs: {
      command: 'docs-server',
      env: { API_TOKEN: 'stored-directly-in-sqlite' }
    }
  }
  saveUserMcpSettings(settings)

  assert.deepEqual(loadUserMcpSettings(), settings)
  const sqlite = (getAppContext().db as unknown as { $client?: Database.Database }).$client
  const row = sqlite
    ?.prepare(`SELECT value_json FROM app_settings WHERE namespace = ?`)
    .get('mcp_json') as { value_json: string } | undefined
  assert.match(row?.value_json ?? '', /stored-directly-in-sqlite/)
  assert.equal(existsSync(join(dataDir, 'mcp-secrets.json')), false)
  assert.equal(existsSync(join(dataDir, 'secrets')), false)
})
