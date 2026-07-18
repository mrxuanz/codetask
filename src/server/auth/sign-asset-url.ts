import { generateAssetToken } from './asset-token'

const ASSET_URL_PATTERN = /\/api\/threads\/([^/?#]+)\/attachments\/([^/?#]+)/
const AUTH_QUERY_KEYS = ['asset_token', 'access_token'] as const
const AUTH_QUERY_PATTERN = /[?&](?:asset_token|access_token)(?:=|&|$)/

function isAbsoluteUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)
}

export function stripAssetUrlAuthTokens(assetUrl: string): string {
  if (!assetUrl || !AUTH_QUERY_PATTERN.test(assetUrl)) return assetUrl

  try {
    const parsed = new URL(assetUrl, 'http://codetask.local')
    for (const key of AUTH_QUERY_KEYS) {
      parsed.searchParams.delete(key)
    }
    if (isAbsoluteUrl(assetUrl)) return parsed.toString()
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return assetUrl
  }
}

function assetUrlWithToken(assetUrl: string, token: string): string {
  try {
    const parsed = new URL(assetUrl, 'http://codetask.local')
    parsed.searchParams.set('asset_token', token)
    if (isAbsoluteUrl(assetUrl)) return parsed.toString()
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    const separator = assetUrl.includes('?') ? '&' : '?'
    return `${assetUrl}${separator}asset_token=${encodeURIComponent(token)}`
  }
}

export function signAssetUrl(authSecret: string, assetUrl: string, owner?: string): string {
  if (!assetUrl) return assetUrl

  const cleanAssetUrl = stripAssetUrlAuthTokens(assetUrl)

  const match = cleanAssetUrl.match(ASSET_URL_PATTERN)
  if (!match) return cleanAssetUrl

  const threadId = decodeURIComponent(match[1]!)
  const attachmentId = decodeURIComponent(match[2]!)
  if (!owner?.trim()) return cleanAssetUrl
  const token = generateAssetToken(authSecret, owner.trim(), threadId, attachmentId)
  return assetUrlWithToken(cleanAssetUrl, token)
}

export function signAssetUrlsInValue(
  authSecret: string,
  value: unknown,
  owner?: string
): unknown {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map((item) => signAssetUrlsInValue(authSecret, item, owner))
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      if ((key === 'assetUrl' || key === 'thumbnailUrl') && typeof child === 'string') {
        next[key] = signAssetUrl(authSecret, child, owner)
      } else {
        next[key] = signAssetUrlsInValue(authSecret, child, owner)
      }
    }
    return next
  }

  return value
}

export function stripAssetUrlAuthTokensInValue(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) {
    return value.map((item) => stripAssetUrlAuthTokensInValue(item))
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(record)) {
      if ((key === 'assetUrl' || key === 'thumbnailUrl') && typeof child === 'string') {
        next[key] = stripAssetUrlAuthTokens(child)
      } else {
        next[key] = stripAssetUrlAuthTokensInValue(child)
      }
    }
    return next
  }

  return value
}
