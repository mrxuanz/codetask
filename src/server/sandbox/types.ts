import type { ConversationRole } from '../agent-runtime/roles'

export type AgentRole = ConversationRole

/**
 * Canonical application sandbox policy.
 *
 * Native protocol discriminators are added only by the wire adapter. Business
 * and scheduling code cannot select a V1/V2/V3 policy API.
 */
export interface SandboxPolicy {
  role: AgentRole
  cwd: string
  /** Ephemeral OS-temp scratch for attestation / worker IPC (native wire: runtime_root). */
  scratchRoot: string
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

export type SandboxBackend = 'linux-bwrap-seccomp' | 'macos-seatbelt' | 'windows-elevated'

export interface SandboxEvidence {
  /** Native attestation protocol; not an application policy selector. */
  protocolVersion: 1 | 2
  active: boolean
  backend: SandboxBackend
  policySha256: string
  sandboxPid: number
  effectiveReadRootsHash?: string | undefined
  effectiveWriteRootsHash?: string | undefined
  warnings: string[]
}

export interface SandboxBootstrapInfo {
  required: boolean
  ready: boolean
  platform: NodeJS.Platform
  backend?: SandboxBackend | undefined
  error?: string | undefined
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
    env?: Array<{ key: string; value: string }> | undefined

    readRoots?: string[] | undefined

    writeRoots?: string[] | undefined
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
