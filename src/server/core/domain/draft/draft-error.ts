export class DraftError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(code)
    this.name = 'DraftError'
  }
}
