import type { ProviderError } from '../events'
import {
  createOpenCodeProviderRuntimeProfile,
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
import { classifyOpenCodeError } from './classify-error'

export type OpenCodeAdapterOptions = {
  /**
   * Stub mode satisfies the unified contract without live OpenCode SDK/CLI.
   * Default true until production SDK wiring lands.
   */
  readonly stubMode?: boolean
}

/**
 * OpenCode provider adapter (production-shaped).
 * Live local-server SDK path is intentionally stubbed for Wave 7C contract green.
 * Auth: host-identity profile (precise paths) — never credential materialize.
 */
export class OpenCodeProviderAdapter implements ProviderAdapter {
  readonly code = 'opencode' as const
  readonly stubMode: boolean

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.stubMode = options.stubMode ?? true
  }

  /** Precise host-identity profile; compiled policy has credentialCopy: false. */
  buildRuntimeProfile(
    input?: BuildProviderRuntimeProfileInput
  ): ProviderRuntimeProfile {
    return createOpenCodeProviderRuntimeProfile(input)
  }

  async discover(): Promise<ProviderAvailability> {
    if (this.stubMode) {
      return { available: true, stub: true, reason: 'opencode stub mode' }
    }
    // Production: probe OpenCode CLI / local server availability.
    return { available: false, reason: 'opencode live discover not wired' }
  }

  async preflight(request?: ProviderPreflightRequest): Promise<ProviderPreflightResult> {
    if (this.stubMode) {
      return { ok: true, stub: true }
    }
    if (request?.skipAuthProbe) {
      return { ok: true }
    }
    return { ok: false, reason: 'opencode live preflight not wired' }
  }

  async runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn> {
    if (!this.stubMode) {
      throw new Error('opencode live runTurn not wired')
    }
    return createStubTurn({ code: this.code, request })
  }

  classifyError(error: unknown): ProviderError {
    return classifyOpenCodeError(error)
  }
}

export function createOpenCodeProviderAdapter(
  options?: OpenCodeAdapterOptions
): OpenCodeProviderAdapter {
  return new OpenCodeProviderAdapter(options)
}
