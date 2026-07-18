import { createHash } from 'crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonObject = { readonly [key: string]: JsonValue }
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

function quoteJsonString(value: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('string is not JSON encodable')
  return encoded
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return quoteJsonString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('number is not JSON encodable')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => canonicalJson(item)).join(',')}]`
  }
  if (!isJsonObject(value)) throw new Error('value is not a JSON object')

  const keys = Object.keys(value).sort()
  const entries = keys.map((key) => {
    const child = value[key]
    if (child === undefined) throw new Error('undefined is not JSON encodable')
    return `${quoteJsonString(key)}:${canonicalJson(child)}`
  })
  return `{${entries.join(',')}}`
}

export function hashCanonicalCommand(commandType: string, payload: unknown): string {
  const canonical =
    payload === null || payload === undefined
      ? commandType
      : `${commandType}:${canonicalJson(payload as JsonValue)}`
  return createHash('sha256').update(canonical).digest('hex')
}
