export class StartupError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'StartupError'
  }
}
