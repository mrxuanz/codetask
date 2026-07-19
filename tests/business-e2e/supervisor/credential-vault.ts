export class CredentialVault {
  private bearerToken: string | undefined
  private username: string | undefined
  private password: string | undefined

  setAccount(username: string, password: string): void {
    this.username = username
    this.password = password
  }

  setBearerToken(token: string): void {
    this.bearerToken = token
  }

  getBearerToken(): string {
    if (!this.bearerToken) throw new Error('vault.token_missing')
    return this.bearerToken
  }

  peekBearerToken(): string | undefined {
    return this.bearerToken
  }

  getUsername(): string {
    if (!this.username) throw new Error('vault.username_missing')
    return this.username
  }

  getPassword(): string {
    if (!this.password) throw new Error('vault.password_missing')
    return this.password
  }

  clear(): void {
    this.bearerToken = undefined
    this.username = undefined
    this.password = undefined
  }
}
