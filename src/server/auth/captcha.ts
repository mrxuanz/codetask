import { randomBytes } from 'crypto'
import { eq, and, lte, or, isNotNull } from 'drizzle-orm'
import { getDb } from '../db'
import { captchaChallenge } from '../db/schema'
import { hmacAuthSecret } from './secret'

const CHALLENGE_ID_PREFIX = 'cpt_'
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const TTL_SEC = 5 * 60
const MAX_ATTEMPTS = 3
const MAX_CHALLENGES = 1000

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[bytes[i] % CHARSET.length]
  }
  return code
}

function generateSvg(code: string): string {
  const width = 180
  const height = 60
  const charWidth = width / code.length

  let chars = ''
  for (let i = 0; i < code.length; i++) {
    const x = i * charWidth + charWidth / 2 - 8
    const y = 35 + Math.sin(i * 1.5) * 8
    const rotate = (Math.sin(i * 2) * 15).toFixed(0)
    chars += `<text x="${x}" y="${y}" transform="rotate(${rotate},${x},${y})" font-size="28" font-family="monospace" fill="#333">${code[i]}</text>`
  }

  let noise = ''
  for (let i = 0; i < 8; i++) {
    const x1 = Math.random() * width
    const y1 = Math.random() * height
    const x2 = x1 + (Math.random() - 0.5) * 40
    const y2 = y1 + (Math.random() - 0.5) * 40
    noise += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ddd" stroke-width="1"/>`
  }

  for (let i = 0; i < 30; i++) {
    noise += `<circle cx="${Math.random() * width}" cy="${Math.random() * height}" r="${Math.random() * 1.5}" fill="#ccc"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#f9f9f9"/>
    ${noise}
    ${chars}
  </svg>`
}

export interface CaptchaChallenge {
  challengeId: string
  image: string
}

function cleanupStaleCaptchaChallenges(): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.delete(captchaChallenge)
    .where(or(lte(captchaChallenge.expiresAt, now), isNotNull(captchaChallenge.usedAt)))
    .run()
}

export async function generateCaptcha(
  authSecret: string,
  scopeKey: string
): Promise<CaptchaChallenge | { error: string }> {
  const db = getDb()
  cleanupStaleCaptchaChallenges()

  db.delete(captchaChallenge).where(eq(captchaChallenge.scopeKey, scopeKey)).run()

  const count = db.select({ id: captchaChallenge.id }).from(captchaChallenge).all()
  if (count.length >= MAX_CHALLENGES) {
    return { error: 'Too many active captcha challenges' }
  }

  const code = randomCode()
  const id = `${CHALLENGE_ID_PREFIX}${randomBytes(12).toString('hex')}`
  const answerLower = code.toLowerCase()
  const answerHash = hmacAuthSecret(authSecret, id, ':', answerLower)
  const now = Math.floor(Date.now() / 1000)

  db.insert(captchaChallenge)
    .values({
      id,
      scopeKey,
      answerHash,
      expiresAt: now + TTL_SEC,
      attempts: 0,
      createdAt: now
    })
    .run()

  const svg = generateSvg(code)
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

  return { challengeId: id, image }
}

export interface CaptchaVerifyResult {
  valid: boolean
  error?: string
}

export async function verifyCaptcha(
  authSecret: string,
  challengeId: string,
  answer: string,
  scopeKey: string
): Promise<CaptchaVerifyResult> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const row = db
    .select()
    .from(captchaChallenge)
    .where(and(eq(captchaChallenge.id, challengeId), eq(captchaChallenge.scopeKey, scopeKey)))
    .get()

  if (!row) {
    return { valid: false, error: 'Captcha challenge not found' }
  }

  if (row.usedAt) {
    return { valid: false, error: 'Captcha already used' }
  }

  if (row.expiresAt <= now) {
    db.delete(captchaChallenge).where(eq(captchaChallenge.id, challengeId)).run()
    return { valid: false, error: 'Captcha expired' }
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    db.delete(captchaChallenge).where(eq(captchaChallenge.id, challengeId)).run()
    return { valid: false, error: 'Captcha attempts exceeded' }
  }

  const expectedHash = hmacAuthSecret(authSecret, challengeId, ':', answer.toLowerCase().trim())

  db.update(captchaChallenge)
    .set({ attempts: row.attempts + 1 })
    .where(eq(captchaChallenge.id, challengeId))
    .run()

  if (!timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(row.answerHash, 'hex'))) {
    return { valid: false, error: 'Invalid captcha answer' }
  }

  db.update(captchaChallenge).set({ usedAt: now }).where(eq(captchaChallenge.id, challengeId)).run()

  return { valid: true }
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}
