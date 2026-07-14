export {
  parseIfMatch,
  parseIdempotencyKey
} from './request-parsers'

export function formatETag(revision: number): string {
  return `"${revision}"`
}
