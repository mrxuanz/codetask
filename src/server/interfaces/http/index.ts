/**
 * HTTP adapters translate transport requests into application commands and
 * queries. Business rules stay in the application and domain layers.
 */
export const HTTP_INTERFACE_LAYER = 'http' as const
export * from './auth-session-cookie'
