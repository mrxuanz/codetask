import type { SandboxPolicy } from './types'

/** The native version discriminator is contained at this one adapter boundary. */
export function serializeSandboxPolicy(policy: SandboxPolicy): string {
  const wire = {
    version: 2,
    role: policy.role,
    cwd: policy.cwd,
    runtime_root: policy.scratchRoot,
    filesystem: {
      default_access: policy.filesystem.defaultAccess,
      allowed_read_roots: policy.filesystem.allowedReadRoots,
      allowed_write_roots: policy.filesystem.allowedWriteRoots,
      protected_names: policy.filesystem.protectedNames,
      allow_system_runtime: policy.filesystem.allowSystemRuntime
    },
    network: {
      mode: policy.network.mode,
      allow_loopback: policy.network.allowLoopback,
      allow_unix_sockets: policy.network.allowUnixSockets
    },
    process: {
      isolate_from_host: policy.process.isolateFromHost,
      allow_own_descendant_signals: policy.process.allowOwnDescendantSignals,
      deny_ptrace: policy.process.denyPtrace
    }
  }
  return JSON.stringify(wire)
}
