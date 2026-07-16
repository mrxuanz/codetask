import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { hmacAuthSecret } from './secret'

export function getClientIp(c: Context): string {
  // @hono/node-server injects { incoming, outgoing } as c.env; missing when fetch drops env.
  if (!c.env) return '127.0.0.1'
  try {
    const info = getConnInfo(c)
    return info.remote.address ?? '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

export function hashIp(authSecret: string, ip: string): string {
  return hmacAuthSecret(authSecret, 'ip:', ip)
}

export function bucketKeyForIp(ipHash: string): string {
  return `ip:${ipHash}`
}

export function scopeKeyForLogin(ipHash: string): string {
  return `login:${ipHash}`
}

export function scopeKeyForCaptcha(ipHash: string): string {
  return `captcha:${ipHash}`
}
