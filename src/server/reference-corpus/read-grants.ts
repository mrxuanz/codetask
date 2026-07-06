import { detectSandboxReadCapabilities } from './sandbox-capabilities'
import type { JobReferenceManifest } from '../../shared/job-references'
import { resolveAssignedReferences } from '../../shared/job-references'

export type ReadGrant = { kind: 'directory'; path: string } | { kind: 'file'; path: string }

export function projectTaskReadGrants(input: {
  workspaceRoot: string
  manifest: JobReferenceManifest
  taskReferenceIds: string[]
}): ReadGrant[] {
  const entries = resolveAssignedReferences(input.manifest, input.taskReferenceIds)
  const caps = detectSandboxReadCapabilities()
  const grants: ReadGrant[] = []
  const seen = new Set<string>()

  const addGrant = (grant: ReadGrant): void => {
    const key = `${grant.kind}:${grant.path.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    grants.push(grant)
  }

  for (const entry of entries) {
    if (entry.inWorkspace) continue

    const resolvedPath = entry.resolvedPath?.trim()
    if (!resolvedPath) {
      if (entry.relativePath) {
        throw new Error(`reference "${entry.id}" missing resolvedPath for sandbox projection`)
      }
      continue
    }

    const source = entry.source ?? 'attachment'
    const kind = entry.kind ?? 'file'

    if (source === 'local_corpus' && kind === 'directory') {
      addGrant({ kind: 'directory', path: resolvedPath })
      continue
    }

    if (source === 'local_corpus' && kind === 'file') {
      if (caps.singleFileAllowlist) {
        addGrant({ kind: 'file', path: resolvedPath })
      } else {
        const parent = parentDirectory(resolvedPath)
        if (!parent) {
          throw new Error(
            `reference "${entry.id}" is a file but sandbox only supports directory read roots`
          )
        }
        addGrant({ kind: 'directory', path: parent })
      }
      continue
    }

    if (source === 'attachment' && kind === 'directory') {
      addGrant({ kind: 'directory', path: resolvedPath })
      continue
    }

    const parent = parentDirectory(resolvedPath)
    if (!parent) {
      throw new Error(`reference "${entry.id}" attachment path has no parent directory`)
    }
    addGrant({ kind: 'directory', path: parent })
  }

  return grants
}

export function readGrantsToReadRoots(grants: ReadGrant[]): string[] {
  const caps = detectSandboxReadCapabilities()
  const roots: string[] = []
  const seen = new Set<string>()

  for (const grant of grants) {
    if (grant.kind === 'file' && caps.singleFileAllowlist) {
      const key = grant.path.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        roots.push(grant.path)
      }
      continue
    }
    const root = grant.kind === 'directory' ? grant.path : parentDirectory(grant.path)
    if (!root) continue
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(root)
  }

  return roots
}

function parentDirectory(filePath: string): string | null {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (idx <= 0) return null
  return filePath.slice(0, idx)
}
