export class DraftDomainError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'DraftDomainError'
  }
}
