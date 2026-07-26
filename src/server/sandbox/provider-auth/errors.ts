import type { SupportedCoreCode } from '../../../shared/providers/codes'
import { SandboxError } from '../types'

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
