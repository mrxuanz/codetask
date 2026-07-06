import type { AnySandboxPolicy, SandboxPolicy, SandboxPolicyV2 } from './types'

function isV2(policy: AnySandboxPolicy): policy is SandboxPolicyV2 {
  return policy.version === 2
}

export function serializeSandboxPolicy(policy: AnySandboxPolicy): string {
  if (isV2(policy)) {
    const wire = {
      version: policy.version,
      role: policy.role,
      cwd: policy.cwd,
      runtime_root: policy.runtimeRoot,
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

  const v1 = policy as SandboxPolicy
  const wire = {
    version: v1.version,
    role: v1.role,
    cwd: v1.cwd,
    runtime_root: v1.runtimeRoot,
    filesystem: {
      default: v1.filesystem.default,
      rules: v1.filesystem.rules.map((rule) => ({
        path: rule.path,
        access: rule.access
      })),
      protected_names: v1.filesystem.protectedNames
    },
    network: {
      ip: v1.network.ip,
      inbound: v1.network.inbound,
      allow_loopback: v1.network.allowLoopback,
      unix_sockets: v1.network.unixSockets
    },
    process: {
      isolate_from_host: v1.process.isolateFromHost,
      allow_own_descendant_signals: v1.process.allowOwnDescendantSignals,
      deny_ptrace: v1.process.denyPtrace
    }
  }
  return JSON.stringify(wire)
}
