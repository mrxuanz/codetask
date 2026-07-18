let listener: ((expiresAt: number) => void) | null = null

export function bindArtifactExpirySignal(next: ((expiresAt: number) => void) | null): void {
  listener = next
}

export function signalArtifactExpiry(expiresAt: number | null | undefined): void {
  if (expiresAt != null) listener?.(expiresAt)
}
