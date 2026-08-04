/**
 * Logical schema registry — ownership map for project-owned aggregates (Batch G).
 * Not a Drizzle schema dump; documents which module owns each table and how it
 * relates to Project / Conversation / Asset.
 */
export type SchemaOwnerKind =
  | 'project'
  | 'conversation'
  | 'draft'
  | 'planning'
  | 'execution'
  | 'asset'
  | 'auth'
  | 'settings'
  | 'realtime'
  | 'system'
  | 'legacy'

export type SchemaTableEntry = {
  table: string
  owner: SchemaOwnerKind
  /** Column pointing at the owning aggregate, when applicable. */
  ownerKey?: string
  notes?: string
}

export const SCHEMA_REGISTRY: readonly SchemaTableEntry[] = Object.freeze([
  { table: 'projects', owner: 'project' },
  {
    table: 'conversation_threads',
    owner: 'project',
    ownerKey: 'project_id',
    notes: 'project_id REFERENCES projects(id) ON DELETE CASCADE (migration 063)'
  },
  {
    table: 'conversation_messages',
    owner: 'conversation',
    ownerKey: 'conversation_id'
  },
  {
    table: 'conversation_message_attachments',
    owner: 'conversation',
    ownerKey: 'conversation_id',
    notes: 'Legacy attachment metadata; mirrored into assets/asset_references'
  },
  {
    table: 'conversation_turns',
    owner: 'conversation',
    ownerKey: 'conversation_id'
  },
  {
    table: 'drafts',
    owner: 'project',
    ownerKey: 'project_id',
    notes: 'project_id REFERENCES projects(id) ON DELETE CASCADE (migration 063)'
  },
  {
    table: 'planning_sessions',
    owner: 'project',
    ownerKey: 'project_id',
    notes: 'project_id REFERENCES projects(id) ON DELETE CASCADE (migration 063)'
  },
  {
    table: 'jobs',
    owner: 'project',
    ownerKey: 'project_id',
    notes: 'project_id REFERENCES projects(id) ON DELETE CASCADE (migration 063)'
  },
  {
    table: 'assets',
    owner: 'asset',
    notes: 'Disk path = dataDir/assets/{storage_key}; pending_delete → async file delete'
  },
  {
    table: 'asset_references',
    owner: 'asset',
    ownerKey: 'owner_id',
    notes: 'Polymorphic owner_type + owner_id'
  },
  { table: 'app_settings', owner: 'settings' },
  { table: 'setting_secrets', owner: 'settings' },
  { table: 'auth_users', owner: 'auth' },
  { table: 'auth_sessions', owner: 'auth' },
  { table: 'realtime_events', owner: 'realtime' },
  { table: 'schema_migrations', owner: 'system' }
])

export function schemaTablesForOwner(owner: SchemaOwnerKind): string[] {
  return SCHEMA_REGISTRY.filter((entry) => entry.owner === owner).map((entry) => entry.table)
}
