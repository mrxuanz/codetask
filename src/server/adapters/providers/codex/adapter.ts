import type { ProviderError } from '../events'
import {
  createCodexProviderRuntimeProfile,
  type BuildProviderRuntimeProfileInput,
  type ProviderRuntimeProfile
} from '../profile/index.ts'
import { createStubTurn } from '../stub-turn'
import type {
  ProviderAdapter,
  ProviderAvailability,
  ProviderPreflightRequest,
  ProviderPreflightResult,
  ProviderTurn,
  ProviderTurnRequest
} from '../types'
import { classifyCodexError } from './classify-error'

export type CodexAdapterOptions = {
  /** Default true until @openai/codex-sdk turn streaming is wired here. */
  readonly stubMode?: boolean
}

/**
 * Codex provider adapter (production-shaped).
 * Live Codex SDK stream normalization lands later; Wave 7C uses stub mode.
 * Auth: host-identity profile (precise paths) — never credential materialize.
 */
export class CodexProviderAdapter implements ProviderAdapter {
  readonly code = 'codex' as const
  readonly stubMode: boolean

  constructor(options: CodexAdapterOptions = {}) {
    this.stubMode = options.stubMode ?? true
  }

  /** Precise host-identity profile; compiled policy has credentialCopy: false. */
  buildRuntimeProfile(
    input?: BuildProviderRuntimeProfileInput
  ): ProviderRuntimeProfile {
    return createCodexProviderRuntimeProfile(input)
  }

  async discover(): Promise<ProviderAvailability> {
    if (this.stubMode) {
      return { available: true, stub: true, reason: 'codex stub mode' }
    }
    return { available: false, reason: 'codex live discover not wired' }
  }

  async preflight(request?: ProviderPreflightRequest): Promise<ProviderPreflightResult> {
    if (this.stubMode) {
      return { ok: true, stub: true }
    }
    if (request?.skipAuthProbe) {
      return { ok: true }
    }
    return { ok: false, reason: 'codex live preflight not wired' }
  }

  async runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn> {
    if (!this.stubMode) {
      throw new Error('codex live runTurn not wired')
    }
    return createStubTurn({ code: this.code, request })
  }

  classifyError(error: unknown): ProviderError {
    return classifyCodexError(error)
  }
}

export function createCodexProviderAdapter(options?: CodexAdapterOptions): CodexProviderAdapter {
  return new CodexProviderAdapter(options)
}
