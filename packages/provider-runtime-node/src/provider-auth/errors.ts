import type { SupportedCoreCode } from '../spec/codes.ts'

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

export class ProviderAuthError extends SandboxError {
  constructor(
    message: string,
    readonly provider: SupportedCoreCode,
    override readonly code: string = 'provider.auth.missing',
    readonly userAction?: string
  ) {
    super(message, code, provider)
    this.name = 'ProviderAuthError'
  }
}
