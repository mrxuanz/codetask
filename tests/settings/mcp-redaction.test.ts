import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MCP_SECRET_MASK,
  defaultUserMcpSettings,
  redactUserMcpSettings
} from '../../src/server/settings/mcp'
import {
  collectMcpSecretReferenceIds,
  protectSubmittedMcpSensitiveValues,
  resolveProtectedMcpSensitiveValues
} from '../../src/server/settings/mcp-secrets'
import {
  EncryptedFileMcpSecretProvider,
  parseMcpSecretReference
} from '../../src/server/settings/mcp-secret-provider'

test('renderer MCP payload masks headers, tokens, passwords, and sensitive env values', () => {
  const settings = defaultUserMcpSettings()
  settings.conversation['claude-code'].mcpServers = {
    docs: {
      headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
      apiKey: 'api-secret',
      password: 'pw',
      env: { PUBLIC_VALUE: 'visible', SERVICE_TOKEN: 'env-secret' }
    }
  }

  const redacted = redactUserMcpSettings(settings)
  const docs = redacted.conversation['claude-code'].mcpServers.docs as {
    headers: Record<string, string>
    apiKey: string
    password: string
    env: Record<string, string>
  }
  assert.equal(docs.headers.Authorization, MCP_SECRET_MASK)
  assert.equal(docs.headers.Accept, 'application/json')
  assert.equal(docs.apiKey, MCP_SECRET_MASK)
  assert.equal(docs.password, MCP_SECRET_MASK)
  assert.equal(docs.env.SERVICE_TOKEN, MCP_SECRET_MASK)
  assert.equal(docs.env.PUBLIC_VALUE, 'visible')
})

test('MCP secrets are encrypted outside settings and resolved only in the trusted parent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-mcp-vault-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const vaultPath = join(root, 'mcp-secrets.json')
  const provider = new EncryptedFileMcpSecretProvider(vaultPath, 'a'.repeat(64))
  const submitted = {
    headers: { Authorization: 'Bearer renderer-secret', Accept: 'application/json' },
    env: { SERVICE_TOKEN: 'environment-secret', PUBLIC_VALUE: 'visible' }
  }

  const protectedValue = protectSubmittedMcpSensitiveValues(submitted, {}, provider)
  const authorization = (protectedValue.headers as Record<string, unknown>).Authorization
  const id = parseMcpSecretReference(authorization)
  assert.ok(id)
  assert.equal(JSON.stringify(protectedValue).includes('renderer-secret'), false)
  assert.equal(readFileSync(vaultPath, 'utf8').includes('renderer-secret'), false)
  assert.deepEqual(resolveProtectedMcpSensitiveValues(protectedValue, provider), submitted)

  const masked = redactUserMcpSettings(protectedValue as never) as unknown as Record<
    string,
    unknown
  >
  const resubmitted = protectSubmittedMcpSensitiveValues(masked, protectedValue, provider)
  assert.equal(
    (resubmitted.headers as Record<string, unknown>).Authorization,
    authorization,
    'masked saves must retain the current reference'
  )
})

test('MCP secret references fail closed when the vault is missing or corrupt', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-mcp-corrupt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'mcp-secrets.json')
  const provider = new EncryptedFileMcpSecretProvider(path, 'c'.repeat(64))
  const missingReference = {
    token: '${secret:00000000-0000-0000-0000-000000000000}'
  }
  assert.throws(
    () => resolveProtectedMcpSensitiveValues(missingReference, provider),
    /reference is missing/
  )
  assert.throws(
    () => resolveProtectedMcpSensitiveValues({ token: 'plaintext-is-not-imported' }, provider),
    /MCP secret is not protected/
  )

  writeFileSync(path, '{broken')
  assert.throws(() => new EncryptedFileMcpSecretProvider(path, 'c'.repeat(64)), /vault is corrupt/)
})

test('submitted reference-shaped MCP values cannot address an existing secret', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-mcp-reference-injection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const provider = new EncryptedFileMcpSecretProvider(
    join(root, 'mcp-secrets.json'),
    'd'.repeat(64)
  )
  const otherId = provider.store('other-secret')
  const injected = `\${secret:${otherId}}`
  const protectedValue = protectSubmittedMcpSensitiveValues({ token: injected }, {}, provider)
  assert.notEqual(parseMcpSecretReference(protectedValue.token), otherId)
  assert.equal(resolveProtectedMcpSensitiveValues(protectedValue, provider).token, injected)
  assert.equal(collectMcpSecretReferenceIds(protectedValue).size, 1)
})
