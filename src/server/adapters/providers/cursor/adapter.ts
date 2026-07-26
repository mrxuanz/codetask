import type { ProviderError } from '../events'
import {
  createCursorProviderRuntimeProfile,
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
import { classifyCursorError } from './classify-error'

export type CursorAdapterOptions = {
  /** Default true until Cursor ACP session streaming is wired here. */
  readonly stubMode?: boolean
}

/**
 * Cursor ACP provider adapter (production-shaped).
 * Live ACP transport is stubbed for Wave 7C contract coverage.
 * Auth: precise Cursor identity paths only — never whole HOME or credential materialize.
 */
export class CursorProviderAdapter implements ProviderAdapter {
  readonly code = 'cursor' as const
  readonly stubMode: boolean

  constructor(options: CursorAdapterOptions = {}) {
    this.stubMode = options.stubMode ?? true
  }

  /**
   * Narrow Cursor identity to resolver-produced paths (no whole HOME).
   * Compiled policy has credentialCopy: false.
   */
  buildRuntimeProfile(
    input?: BuildProviderRuntimeProfileInput
  ): ProviderRuntimeProfile {
    return createCursorProviderRuntimeProfile(input)
  }

  async discover(): Promise<ProviderAvailability> {
    if (this.stubMode) {
      return { available: true, stub: true, reason: 'cursor stub mode' }
    }
    return { available: false, reason: 'cursor live discover not wired' }
  }

  async preflight(request?: ProviderPreflightRequest): Promise<ProviderPreflightResult> {
    if (this.stubMode) {
      return { ok: true, stub: true }
    }
    if (request?.skipAuthProbe) {
      return { ok: true }
    }
    return { ok: false, reason: 'cursor live preflight not wired' }
  }

  async runTurn(request?: ProviderTurnRequest): Promise<ProviderTurn> {
    if (!this.stubMode) {
      throw new Error('cursor live runTurn not wired')
    }
    return createStubTurn({ code: this.code, request })
  }

  classifyError(error: unknown): ProviderError {
    return classifyCursorError(error)
  }
}

export function createCursorProviderAdapter(
  options?: CursorAdapterOptions
): CursorProviderAdapter {
  return new CursorProviderAdapter(options)
}
