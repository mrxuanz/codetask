export type Account = {
  id: string
  username: string
  normalizedUsername: string
  passwordVersion: number
  disabledAt: number | null
  createdAt: number
  updatedAt: number
}

export type AuthUserRecord = {
  id: string
  username: string
  normalizedUsername: string
  passwordHash: string
  passwordVersion: number
  disabledAtMs: number | null
}
