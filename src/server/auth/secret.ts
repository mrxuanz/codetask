import { randomBytes, createHmac } from 'crypto'

const SECRET_KEY = 'security.authSecretV1'
const SECRET_LENGTH = 32

function generateSecret(): string {
  return randomBytes(SECRET_LENGTH).toString('hex')
}

export function getOrCreateAuthSecret(settings: {
  read(): Record<string, unknown>
  patch(mutator: (file: Record<string, unknown>) => void): void
}): string {
  const file = settings.read()
  const existing = file[SECRET_KEY]
  if (typeof existing === 'string' && existing.length === SECRET_LENGTH * 2) {
    return existing
  }

  const secret = generateSecret()
  settings.patch((f) => {
    f[SECRET_KEY] = secret
  })
  return secret
}

export function hmacAuthSecret(authSecret: string, ...parts: string[]): string {
  return createHmac('sha256', authSecret).update(parts.join('')).digest('hex')
}
