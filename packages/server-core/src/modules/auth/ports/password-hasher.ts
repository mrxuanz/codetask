export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, stored: string): Promise<boolean>
  dummyHash: string
}

export interface TokenDigester {
  digest(kind: string, value: string): string
}

export interface Clock {
  nowMs(): number
}
