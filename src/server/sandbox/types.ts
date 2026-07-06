import type { ConversationRole } from '../agent-runtime/roles'

export type AgentRole = ConversationRole

export interface FileRule {
  path: string
  access: 'read' | 'write' | 'none'
}

export interface SandboxPolicy {
  version: 1
  role: AgentRole
  cwd: string
  runtimeRoot: string
  filesystem: {
    default: 'none' | 'read'
    rules: FileRule[]
    protectedNames: string[]
  }
  network: {
    ip: 'full' | 'none'
    inbound: boolean
    allowLoopback: boolean
    unixSockets: string[]
  }
  process: {
    isolateFromHost: true
    allowOwnDescendantSignals: true
    denyPtrace: true
  }
}

export interface SandboxPolicyV2 {
  version: 2
  role: AgentRole
  cwd: string
  runtimeRoot: string
  filesystem: {
    defaultAccess: 'none'
    allowedReadRoots: string[]
    allowedWriteRoots: string[]
    protectedNames: string[]
    allowSystemRuntime: boolean
  }
  network: {
    mode: 'none' | 'restricted' | 'full'
    allowLoopback: boolean
    allowUnixSockets: string[]
  }
  process: {
    isolateFromHost: boolean
    denyPtrace: boolean
    allowOwnDescendantSignals: boolean
  }
}

export type AnySandboxPolicy = SandboxPolicy | SandboxPolicyV2

export function isSandboxPolicyV2(policy: AnySandboxPolicy): policy is SandboxPolicyV2 {
  return policy.version === 2
}

export type SandboxBackend = 'linux-bwrap-seccomp' | 'macos-seatbelt' | 'windows-elevated'

export interface SandboxRunRequest {
  protocolVersion: 1 | 2
  policy: AnySandboxPolicy
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SandboxEvidence {
  protocolVersion: 1 | 2
  active: boolean
  backend: SandboxBackend
  policySha256: string
  sandboxPid: number
  effectiveReadRootsHash?: string
  effectiveWriteRootsHash?: string
  warnings: string[]
}

export interface SandboxBootstrapInfo {
  required: boolean
  ready: boolean
  platform: NodeJS.Platform
  backend?: SandboxBackend
  error?: string
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly requirement?: string
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

export interface CodeteamSandboxNative {
  preflight(): void
  resolveHelperPath(): string
  helperVersion(): string
  runSelfTest(): void
  windowsSetupStatus(sandboxHome?: string | null): boolean
  windowsSetup(
    nodeExe: string,
    setupScript: string,
    runnerScript: string,
    sandboxHome: string,
    policyCwd: string
  ): void
  runSetupHelper(payloadB64: string): void
  runCommandRunner(args: string[]): void
  launchSandboxedWorker(options: {
    policyJson: string
    command: string
    args: string[]
    cwd: string
    env?: Array<{ key: string; value: string }>

    readRoots?: string[]

    writeRoots?: string[]
  }): {
    get pid(): number
    get evidence(): {
      protocolVersion: number
      active: boolean
      backend: string
      policySha256: string
      sandboxPid: number
      effectiveReadRootsHash?: string
      effectiveWriteRootsHash?: string
      warnings: string[]
    }
    writeStdin(data: Buffer): void
    endStdin(): void
    readStdoutChunk(maxBytes?: number | null): Buffer
    readStderrChunk(maxBytes?: number | null): Buffer
    waitForAttestation(timeoutMs?: number | null): boolean
    kill(): void

    pollExit(): number | null

    wait(): number
    close(): void
  }
}
