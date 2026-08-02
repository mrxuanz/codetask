export type Session = {
  id: string
  userId: string
  tokenDigest: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revokedAt: number | null
  revokeReason: string | null
}
