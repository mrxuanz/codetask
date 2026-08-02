export type Actor = {
  userId: string
  username: string
  sessionId: string
  sessionExpiresAt: number
}

/** Principal used inside Auth application (session-bound). */
export type AuthPrincipal = {
  userId: string
  username: string
  sessionId: string
  expiresAtMs: number
}

export function principalToActor(principal: AuthPrincipal): Actor {
  return {
    userId: principal.userId,
    username: principal.username,
    sessionId: principal.sessionId,
    sessionExpiresAt: Math.floor(principal.expiresAtMs / 1000)
  }
}

/** Slim actor for Design / Conversation / Execution module ports. */
export function toModuleActor(actor: Actor): { userId: string; sessionId: string } {
  return { userId: actor.userId, sessionId: actor.sessionId }
}
