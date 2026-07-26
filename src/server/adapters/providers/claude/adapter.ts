import type { ProviderError } from '../events'
import {
  createClaudeProviderRuntimeProfile,
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
import { classifyClaudeError } from './classify-error'

export type ClaudeAdapterOptions = {
  /** Default true until Claude Code SDK turn streaming is wired here. */
  readonly stubMode?: boolean
}

/**
 * Claude Code provider adapter (production-shaped).
 * Live Anthropic Claude Code SDK path is stubbed for Wave 7C.
 * Auth: host-identity profile (precise paths) — never credential materialize.
 */
export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly code = 'claude' as const
  readonly stubMode: boolean

  constructor(options: ClaudeAdapterOptions = {}) {
    this.stubMode = options.stubMode ?? true
  }

  /** Precise host-identity profile; compiled policy has credentialCopy: false. */
  buildRuntimeProfile(
    input?: BuildProviderRuntimeProfileInput
  ): ProviderRuntimeProfile {
    return createClaudeProviderRuntimeProfile(input)
  }

  async discover(): Promise<ProviderAvailability> {
    if (this.stubMode) {
      return { available: true, stub: true, reason: 'claude stub mode' }
    }
    return { available: false, reason: 'claude live discover not wired' }
  }

  async preflight(request?: ProviderPreflightRequest): Promise<ProviderPreflightResult> {
    if (this.stubMode) {
      return { ok: true, stub: true }
    }
    if (request?.skipAuthProbe) {
      return { ok: true }
    }
    return { ok: false, reason: 'claude live preflight not wired' }
  }

  async runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn> {
    if (!this.stubMode) {
      throw new Error('claude live runTurn not wired')
    }
    return createStubTurn({ code: this.code, request })
  }

  classifyError(error: unknown): ProviderError {
    return classifyClaudeError(error)
  }
}

export function createClaudeProviderAdapter(
  options?: ClaudeAdapterOptions
): ClaudeProviderAdapter {
  return new ClaudeProviderAdapter(options)
}
