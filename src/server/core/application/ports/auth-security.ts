export interface PasswordVerification {
  readonly valid: boolean
  readonly needsRehash: boolean
}

export class AuthSecurityCapacityError extends Error {
  constructor() {
    super('auth.security_capacity_exceeded')
    this.name = 'AuthSecurityCapacityError'
  }
}

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, encodedHash: string | null): Promise<PasswordVerification>
}

export interface SecureTokenService {
  generateToken(byteLength?: number): string
  digest(context: string, value: string): string
  equalsDigest(left: string, right: string): boolean
}

export interface HumanChallenge {
  readonly answer: string
  readonly publicPayload: string
}

export interface HumanChallengeGenerator {
  generate(): HumanChallenge
}

export interface SetupGrantVerifier {
  verify(grant: string, nowMs: number): boolean
}
