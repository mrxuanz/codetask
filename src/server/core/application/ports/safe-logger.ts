export interface SafeLogger {
  info(message: string, fields?: Record<string, string | number | boolean>): void
  warn(message: string, fields?: Record<string, string | number | boolean>): void
  error(message: string, fields?: Record<string, string | number | boolean>): void
}
