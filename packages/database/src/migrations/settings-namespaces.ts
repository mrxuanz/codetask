import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type AuthMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

const DEFAULT_PROVIDER = 'cursor'
const PROVIDER_CODES = ['codex', 'claude', 'opencode', 'cursor'] as const
type ProviderCode = (typeof PROVIDER_CODES)[number]

const MCP_ROOT_KEYS: Record<ProviderCode, string> = {
  codex: 'mcp_servers',
  claude: 'mcpServers',
  opencode: 'mcp',
  cursor: 'mcpServers'
}

const PROMPT_ROLES = ['conversation', 'planner', 'sliceVerifier', 'milestoneVerifier'] as const
const AGENT_MCP_ROLES = ['conversation', 'planner', 'task', 'verification'] as const

const PLAINTEXT_SECRET_KEY = /token|password|api[_-]?key|authorization|secret/i
const FALLBACK_MIGRATION_KEY = 'codetask-settings-migration-v1'
const SECRET_BACKEND = 'encrypted'
const NONCE_BYTES = 12

const NAMESPACES_TO_DELETE = [
  'business_skills',
  'ui_server_preferences',
  'retention',
  'control_plane',
  'prompts',
  'mcp_json'
] as const

type SettingsRow = {
  namespace: string
  value_json: string
  schema_version: number
  revision: number
  updated_at: number
}

type SecretReportEntry = {
  path: string
  secretName: string
  extracted: boolean
  error?: string
}

type SecretReport = {
  entries: SecretReportEntry[]
  usedFallbackMigrationKey?: boolean
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function namespaceExists(db: Database.Database, namespace: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 AS ok FROM app_settings WHERE namespace = ? LIMIT 1`).get(namespace)
  )
}

function readNamespaceRow(db: Database.Database, namespace: string): SettingsRow | undefined {
  return db
    .prepare(
      `SELECT namespace, value_json, schema_version, revision, updated_at
         FROM app_settings
        WHERE namespace = ?`
    )
    .get(namespace) as SettingsRow | undefined
}

function parseNamespaceValue(row: SettingsRow | undefined): Record<string, unknown> | null {
  if (!row) return null
  const value = JSON.parse(row.value_json) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function upsertNamespace(
  db: Database.Database,
  namespace: string,
  value: Record<string, unknown>,
  revision: number,
  schemaVersion: number,
  updatedAt: number
): void {
  db.prepare(
    `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(namespace) DO UPDATE SET
       value_json = excluded.value_json,
       schema_version = excluded.schema_version,
       revision = excluded.revision,
       updated_at = excluded.updated_at`
  ).run(namespace, JSON.stringify(value), schemaVersion, revision, updatedAt)
}

function deleteNamespace(db: Database.Database, namespace: string): void {
  db.prepare(`DELETE FROM app_settings WHERE namespace = ?`).run(namespace)
}

function isProviderCode(value: unknown): value is ProviderCode {
  return typeof value === 'string' && (PROVIDER_CODES as readonly string[]).includes(value)
}

function normalizeProviderCode(value: unknown): ProviderCode {
  if (isProviderCode(value)) return value
  return DEFAULT_PROVIDER
}

function isSecretReference(value: unknown): value is { $secret: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 1 && keys[0] === '$secret' && typeof record.$secret === 'string'
}

/**
 * Settings migration key resolution (Batch E).
 * Product must not read CODETASK_* env — use durable auth_secret, else fallback.
 * Runtime Settings encryption uses SecretKeyProvider (installation.key / --master-key-file).
 */
function resolveMasterKey(db: Database.Database): {
  key: Buffer
  usedFallbackMigrationKey: boolean
} {
  if (tableExists(db, 'auth_secret')) {
    try {
      const row = db
        .prepare(`SELECT secret_hex AS secret FROM auth_secret WHERE singleton_key = 1 LIMIT 1`)
        .get() as { secret?: unknown } | undefined
      if (typeof row?.secret === 'string' && /^[0-9a-fA-F]{64}$/.test(row.secret)) {
        return { key: Buffer.from(row.secret, 'hex'), usedFallbackMigrationKey: false }
      }
    } catch {
      // Fall through to migration fallback key.
    }
  }

  return {
    key: createHash('sha256').update(FALLBACK_MIGRATION_KEY, 'utf8').digest(),
    usedFallbackMigrationKey: true
  }
}

function sanitizeSecretPath(path: string): string {
  return path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
}

function recordMigrationFailure(
  db: Database.Database,
  migrationName: string,
  sourceKey: string,
  reason: string,
  payload?: unknown
): void {
  if (!tableExists(db, 'migration_failures')) return
  db.prepare(
    `INSERT INTO migration_failures (id, migration_name, source_key, reason, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    migrationName,
    sourceKey,
    reason,
    payload === undefined ? null : JSON.stringify(payload),
    Date.now()
  )
}

function ensureSettingSecretsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setting_secrets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      backend TEXT NOT NULL,
      external_ref TEXT,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

function insertEncryptedSecret(
  db: Database.Database,
  key: Buffer,
  name: string,
  plaintext: string
): void {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  const now = Math.floor(Date.now() / 1000)

  const existing = db.prepare(`SELECT id FROM setting_secrets WHERE name = ?`).get(name) as
    | { id: string }
    | undefined

  if (existing) {
    db.prepare(
      `UPDATE setting_secrets
          SET ciphertext = ?, nonce = ?, auth_tag = ?, updated_at = ?
        WHERE name = ?`
    ).run(
      encrypted.toString('base64'),
      nonce.toString('base64'),
      authTag.toString('base64'),
      now,
      name
    )
    return
  }

  db.prepare(
    `INSERT INTO setting_secrets (
       id, name, backend, external_ref, ciphertext, nonce, auth_tag, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    name,
    SECRET_BACKEND,
    encrypted.toString('base64'),
    nonce.toString('base64'),
    authTag.toString('base64'),
    now,
    now
  )
}

function migrateControlPlane(db: Database.Database): void {
  const row = readNamespaceRow(db, 'control_plane')
  if (!row) return

  if (!namespaceExists(db, 'agent_defaults')) {
    const raw = parseNamespaceValue(row) ?? {}
    const source =
      raw.policies && typeof raw.policies === 'object' && !Array.isArray(raw.policies)
        ? (raw.policies as Record<string, unknown>)
        : raw

    const value = {
      plannerProvider: normalizeProviderCode(source.plannerCoreCode),
      sliceVerifierProvider: normalizeProviderCode(source.sliceVerifierCoreCode),
      milestoneVerifierProvider: normalizeProviderCode(source.milestoneVerifierCoreCode)
    }

    upsertNamespace(db, 'agent_defaults', value, row.revision, row.schema_version, row.updated_at)
  }

  deleteNamespace(db, 'control_plane')
}

function migratePrompts(db: Database.Database): void {
  const row = readNamespaceRow(db, 'prompts')
  if (!row) return

  if (!namespaceExists(db, 'agent_prompts')) {
    const raw = parseNamespaceValue(row) ?? {}
    const value: Record<string, { mode: 'default' | 'custom'; body: string }> = {}

    for (const role of PROMPT_ROLES) {
      const entry = raw[role]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        value[role] = { mode: 'default', body: '' }
        continue
      }
      const record = entry as Record<string, unknown>
      const useDefault = record.useDefault !== false
      const body = typeof record.body === 'string' ? record.body : ''
      value[role] = useDefault ? { mode: 'default', body: '' } : { mode: 'custom', body }
    }

    upsertNamespace(db, 'agent_prompts', value, row.revision, row.schema_version, row.updated_at)
  }

  deleteNamespace(db, 'prompts')
}

type RoleMcpSettings = Record<ProviderCode, Record<string, unknown>>

function emptyProviderFragment(providerCode: ProviderCode): Record<string, unknown> {
  return { [MCP_ROOT_KEYS[providerCode]]: {} }
}

function defaultRoleMcpSettings(): RoleMcpSettings {
  return Object.fromEntries(
    PROVIDER_CODES.map((code) => [code, emptyProviderFragment(code)])
  ) as RoleMcpSettings
}

function parseLegacyRoleSettings(value: unknown): RoleMcpSettings {
  const defaults = defaultRoleMcpSettings()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults
  }
  const object = value as Record<string, unknown>
  for (const code of PROVIDER_CODES) {
    if (object[code] !== undefined && object[code] && typeof object[code] === 'object') {
      defaults[code] = structuredClone(object[code] as Record<string, unknown>)
    }
  }
  return defaults
}

function transformLegacyMcpJson(raw: Record<string, unknown>): {
  roles: Record<(typeof AGENT_MCP_ROLES)[number], RoleMcpSettings>
} {
  const conversation = parseLegacyRoleSettings(raw.conversation)
  return {
    roles: {
      conversation,
      planner: structuredClone(conversation),
      task: parseLegacyRoleSettings(raw.task),
      verification: parseLegacyRoleSettings(raw.verification)
    }
  }
}

function extractPlaintextSecrets(
  value: unknown,
  path: string,
  ctx: {
    counter: number
    key: Buffer
    db: Database.Database
    report: SecretReportEntry[]
  }
): number {
  if (value === null || value === undefined) return ctx.counter
  if (isSecretReference(value)) return ctx.counter
  if (typeof value === 'string') return ctx.counter

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      ctx.counter = extractPlaintextSecrets(value[index], `${path}[${index}]`, ctx)
    }
    return ctx.counter
  }

  if (typeof value !== 'object') return ctx.counter

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`
    if (
      PLAINTEXT_SECRET_KEY.test(key) &&
      typeof child === 'string' &&
      child.length > 0 &&
      !isSecretReference(child)
    ) {
      const secretName = `migrated-${ctx.counter}-${sanitizeSecretPath(childPath)}`
      ctx.counter += 1
      try {
        insertEncryptedSecret(ctx.db, ctx.key, secretName, child)
        record[key] = { $secret: secretName }
        ctx.report.push({ path: childPath, secretName, extracted: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.report.push({ path: childPath, secretName, extracted: false, error: message })
        recordMigrationFailure(
          ctx.db,
          'settings_namespaces',
          childPath,
          `secret_encryption_failed:${message}`,
          { secretName, path: childPath }
        )
      }
    } else {
      ctx.counter = extractPlaintextSecrets(child, childPath, ctx)
    }
  }

  return ctx.counter
}

function migrateMcpJson(db: Database.Database): void {
  const row = readNamespaceRow(db, 'mcp_json')
  if (!row) return

  if (!namespaceExists(db, 'agent_mcp')) {
    const raw = parseNamespaceValue(row) ?? {}
    const transformed = transformLegacyMcpJson(raw)

    const { key, usedFallbackMigrationKey } = resolveMasterKey(db)
    const report: SecretReport = {
      entries: [],
      ...(usedFallbackMigrationKey ? { usedFallbackMigrationKey: true } : {})
    }

    let counter = 1
    for (const role of AGENT_MCP_ROLES) {
      counter = extractPlaintextSecrets(transformed.roles[role], `agent_mcp.roles.${role}`, {
        counter,
        key,
        db,
        report: report.entries
      })
    }

    if (report.entries.length > 0) {
      recordMigrationFailure(
        db,
        'settings_namespaces_secret_report',
        'mcp_plaintext',
        JSON.stringify(report)
      )
    }

    upsertNamespace(
      db,
      'agent_mcp',
      transformed as unknown as Record<string, unknown>,
      row.revision,
      row.schema_version,
      row.updated_at
    )
  }

  deleteNamespace(db, 'mcp_json')
}

function migrateProviderRuntime(db: Database.Database): void {
  const row = readNamespaceRow(db, 'provider_runtime')
  if (!row) return

  const raw = parseNamespaceValue(row)
  if (!raw || raw.providers !== undefined) return

  upsertNamespace(
    db,
    'provider_runtime',
    { providers: raw },
    row.revision,
    row.schema_version,
    row.updated_at
  )
}

function deleteLegacyNamespaces(db: Database.Database): void {
  for (const namespace of NAMESPACES_TO_DELETE) {
    deleteNamespace(db, namespace)
  }
}

/**
 * Settings architecture cutover: rename namespaces, extract MCP plaintext secrets,
 * create setting_secrets, and remove retired namespaces.
 */
export const migration053SettingsNamespaces: AuthMigration = {
  version: 53,
  name: 'settings_namespaces',
  up(db) {
    if (!tableExists(db, 'app_settings')) return

    ensureSettingSecretsTable(db)

    db.transaction(() => {
      migrateControlPlane(db)
      migratePrompts(db)
      migrateMcpJson(db)
      migrateProviderRuntime(db)
      deleteLegacyNamespaces(db)
    })()
  }
}
