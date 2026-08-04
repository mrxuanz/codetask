import type Database from 'better-sqlite3'

export type ProviderCanonicalMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

const ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  codex: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  claude_code: 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  cursorcli: 'cursor',
  'cursor-cli': 'cursor',
  'cursor-agent': 'cursor',
  cursor_cli: 'cursor'
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function toCanonical(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return ALIAS_TO_CANONICAL[value.trim().toLowerCase()] ?? null
}

function remapProviderKeyedObject(
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const canonical = toCanonical(key) ?? key
    // Prefer already-canonical entries when both alias and canonical exist.
    if (next[canonical] !== undefined && key !== canonical) continue
    next[canonical] = value
  }
  return next
}

function rewriteAgentDefaults(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  for (const field of ['plannerProvider', 'sliceVerifierProvider', 'milestoneVerifierProvider']) {
    const canonical = toCanonical(next[field])
    if (canonical) next[field] = canonical
  }
  return next
}

function rewriteAgentMcp(value: Record<string, unknown>): Record<string, unknown> {
  const rolesRaw = value.roles
  if (!rolesRaw || typeof rolesRaw !== 'object' || Array.isArray(rolesRaw)) return value
  const roles: Record<string, unknown> = {}
  for (const [role, roleValue] of Object.entries(rolesRaw as Record<string, unknown>)) {
    if (!roleValue || typeof roleValue !== 'object' || Array.isArray(roleValue)) {
      roles[role] = roleValue
      continue
    }
    roles[role] = remapProviderKeyedObject(roleValue as Record<string, unknown>)
  }
  return { ...value, roles }
}

function rewriteProviderRuntime(value: Record<string, unknown>): Record<string, unknown> {
  const providers = value.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return value
  return {
    ...value,
    providers: remapProviderKeyedObject(providers as Record<string, unknown>)
  }
}

/**
 * Batch F: normalize Settings provider codes to canonical
 * `codex | claude | opencode | cursor` (drop settings-level claude-code/cursorcli).
 */
export const migration061CanonicalProviderCodes: ProviderCanonicalMigration = {
  version: 61,
  name: 'canonical_provider_codes',
  up(db) {
    if (!tableExists(db, 'app_settings')) return

    const rows = db
      .prepare(
        `SELECT namespace, value_json, schema_version, revision, updated_at
           FROM app_settings
          WHERE namespace IN ('agent_defaults', 'agent_mcp', 'provider_runtime')`
      )
      .all() as Array<{
      namespace: string
      value_json: string
      schema_version: number
      revision: number
      updated_at: number
    }>

    const update = db.prepare(
      `UPDATE app_settings
          SET value_json = ?, updated_at = ?
        WHERE namespace = ?`
    )

    const now = Math.floor(Date.now() / 1000)
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.value_json)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const value = parsed as Record<string, unknown>
      let next = value
      if (row.namespace === 'agent_defaults') next = rewriteAgentDefaults(value)
      else if (row.namespace === 'agent_mcp') next = rewriteAgentMcp(value)
      else if (row.namespace === 'provider_runtime') next = rewriteProviderRuntime(value)

      const serialized = JSON.stringify(next)
      if (serialized === row.value_json) continue
      update.run(serialized, now, row.namespace)
    }
  }
}
