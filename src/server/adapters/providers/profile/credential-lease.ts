/**
 * Provider/account-level Credential Lease for shared host identity refresh
 * (OAuth token write-back). Model turns may still run in parallel; only
 * credential mutation is serialized (重构.md §8.6 / §8.7).
 *
 * Crash recovery: expired or orphaned leases are reclaimable; fence tokens
 * prevent a late writer from committing after a newer holder acquired the lease.
 */

export interface CredentialLease {
  readonly leaseId: string
  readonly provider: string
  readonly accountKey: string
  readonly holderInstanceId: string
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
  readonly fenceToken: number
}

export interface AcquireCredentialLeaseInput {
  readonly provider: string
  readonly accountKey: string
  readonly holderInstanceId: string
  readonly nowMs: number
  readonly ttlMs: number
}

export class CredentialLeaseError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'CredentialLeaseError'
    this.code = code
  }
}

function scopeKey(provider: string, accountKey: string): string {
  return `${provider}::${accountKey}`
}

export class CredentialLeaseStore {
  private readonly leases = new Map<string, CredentialLease>()
  private fence = 0
  private seq = 0

  /**
   * Acquire (or reclaim expired) a short-lived lease for credential mutation.
   * Fails if another live holder owns the scope.
   */
  acquire(input: AcquireCredentialLeaseInput): CredentialLease {
    if (!input.provider.trim() || !input.accountKey.trim()) {
      throw new CredentialLeaseError('provider and accountKey required', 'lease.incomplete')
    }
    if (!input.holderInstanceId.trim()) {
      throw new CredentialLeaseError('holderInstanceId required', 'lease.incomplete')
    }
    if (input.ttlMs <= 0) {
      throw new CredentialLeaseError('ttlMs must be positive', 'lease.invalid_ttl')
    }

    const key = scopeKey(input.provider, input.accountKey)
    const existing = this.leases.get(key)
    if (existing && existing.expiresAtMs > input.nowMs) {
      if (existing.holderInstanceId === input.holderInstanceId) {
        // Renew for same holder.
        const renewed: CredentialLease = {
          ...existing,
          acquiredAtMs: input.nowMs,
          expiresAtMs: input.nowMs + input.ttlMs
        }
        this.leases.set(key, renewed)
        return renewed
      }
      throw new CredentialLeaseError(
        `Credential lease held by ${existing.holderInstanceId}`,
        'lease.held'
      )
    }

    // Crash recovery path: expired / missing lease → reclaim with new fence.
    this.fence += 1
    this.seq += 1
    const lease: CredentialLease = {
      leaseId: `cred-lease-${this.seq}`,
      provider: input.provider,
      accountKey: input.accountKey,
      holderInstanceId: input.holderInstanceId,
      acquiredAtMs: input.nowMs,
      expiresAtMs: input.nowMs + input.ttlMs,
      fenceToken: this.fence
    }
    this.leases.set(key, lease)
    return lease
  }

  release(provider: string, accountKey: string, holderInstanceId: string, fenceToken: number): void {
    const key = scopeKey(provider, accountKey)
    const existing = this.leases.get(key)
    if (!existing) return
    if (existing.holderInstanceId !== holderInstanceId || existing.fenceToken !== fenceToken) {
      throw new CredentialLeaseError('Cannot release lease; fence mismatch', 'lease.fence_mismatch')
    }
    this.leases.delete(key)
  }

  /**
   * Drop expired leases (crash recovery sweeper). Returns recovered lease ids.
   */
  recoverExpired(nowMs: number): readonly string[] {
    const recovered: string[] = []
    for (const [key, lease] of this.leases) {
      if (lease.expiresAtMs <= nowMs) {
        recovered.push(lease.leaseId)
        this.leases.delete(key)
      }
    }
    return recovered
  }

  get(provider: string, accountKey: string): CredentialLease | undefined {
    return this.leases.get(scopeKey(provider, accountKey))
  }

  /**
   * Validate a holder still owns the lease before writing credentials.
   * Rejects stale fence tokens after crash reclaim.
   */
  assertWritable(
    provider: string,
    accountKey: string,
    holderInstanceId: string,
    fenceToken: number,
    nowMs: number
  ): void {
    const lease = this.get(provider, accountKey)
    if (!lease || lease.expiresAtMs <= nowMs) {
      throw new CredentialLeaseError('No live credential lease', 'lease.missing')
    }
    if (lease.holderInstanceId !== holderInstanceId || lease.fenceToken !== fenceToken) {
      throw new CredentialLeaseError('Stale credential lease fence', 'lease.stale_fence')
    }
  }
}

export const defaultCredentialLeaseStore = new CredentialLeaseStore()
