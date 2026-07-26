import { resolve } from 'path'
import type { AgentRole, SandboxPolicy } from './types'
import type { WorkspaceAccessMode } from '../../shared/workspace-access.ts'
import { compileSandboxPolicy, canonicalizePath } from './paths'

const PROTECTED_NAMES = ['.agents', '.codex', '.codeteam', '.git'] as const

function mergeUniqueRoots(existing: string[], extra: string[]): string[] {
  const seen = new Set(existing.map((path) => path.toLowerCase()))
  const merged = [...existing]
  for (const root of extra) {
    const trimmed = root.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(trimmed)
  }
  return merged
}

export function applyProviderWriteRoots(
  policy: SandboxPolicy,
  writeRoots: string[] | undefined
): SandboxPolicy {
  if (!writeRoots?.length) return policy
  const merged = mergeUniqueRoots(policy.filesystem.allowedWriteRoots, writeRoots)
  if (merged.length === policy.filesystem.allowedWriteRoots.length) return policy
  return compileSandboxPolicy({
    ...policy,
    filesystem: {
      ...policy.filesystem,
      allowedWriteRoots: merged
    }
  })
}

export function applyProviderReadRoots(
  policy: SandboxPolicy,
  readRoots: string[] | undefined
): SandboxPolicy {
  if (!readRoots?.length) return policy
  const merged = mergeUniqueRoots(policy.filesystem.allowedReadRoots, readRoots)
  if (merged.length === policy.filesystem.allowedReadRoots.length) return policy

  return compileSandboxPolicy({
    ...policy,
    filesystem: {
      ...policy.filesystem,
      allowedReadRoots: merged
    }
  })
}

export function collectPolicyWriteRoots(policy: SandboxPolicy): string[] {
  return [...policy.filesystem.allowedWriteRoots]
}

export function collectPolicyReadRoots(policy: SandboxPolicy): string[] {
  return [...policy.filesystem.allowedReadRoots]
}

export function createSandboxPolicy(input: {
  role: AgentRole
  workspaceRoot: string
  runtimeRoot: string
  verifierOutputRoot?: string
  providerReadRoots?: string[]
  providerWriteRoots?: string[]
  attachmentReadRoots?: string[]
  workspaceAccess?: WorkspaceAccessMode
}): SandboxPolicy {
  const workspaceRoot = canonicalizePath(input.workspaceRoot)
  const runtimeRoot = canonicalizePath(input.runtimeRoot)

  const allowedReadRoots = [
    workspaceRoot,
    runtimeRoot,
    ...(input.providerReadRoots ?? []),
    ...(input.attachmentReadRoots ?? [])
  ].map((root) => canonicalizePath(root))

  const allowedWriteRoots: string[] = [runtimeRoot]

  if (input.role === 'task-worker' && input.workspaceAccess === 'exclusive-write') {
    allowedWriteRoots.push(workspaceRoot)
  }

  if (
    (input.role === 'work-verifier' ||
      input.role === 'milestone-verifier' ||
      input.role === 'slice-verifier') &&
    input.verifierOutputRoot
  ) {
    allowedWriteRoots.push(resolve(input.verifierOutputRoot))
  }

  if (input.providerWriteRoots?.length) {
    allowedWriteRoots.push(...input.providerWriteRoots)
  }

  const uniqueRead = mergeUniqueRoots([], allowedReadRoots)

  return compileSandboxPolicy({
    role: input.role,
    cwd: canonicalizePath(workspaceRoot),
    runtimeRoot: canonicalizePath(runtimeRoot),
    filesystem: {
      defaultAccess: 'none',
      allowedReadRoots: uniqueRead,
      allowedWriteRoots: allowedWriteRoots.map((root) => canonicalizePath(root)),
      protectedNames: [...PROTECTED_NAMES],
      allowSystemRuntime: true
    },
    network: {
      mode: 'full',
      allowLoopback: true,
      allowUnixSockets: []
    },
    process: {
      isolateFromHost: true,
      allowOwnDescendantSignals: true,
      denyPtrace: true
    }
  })
}

export function isTaskRole(role: AgentRole): boolean {
  return role === 'task-worker'
}

export function roleAllowsShell(role: AgentRole): boolean {
  return (
    role === 'task-worker' ||
    role === 'work-verifier' ||
    role === 'milestone-verifier' ||
    role === 'slice-verifier'
  )
}
