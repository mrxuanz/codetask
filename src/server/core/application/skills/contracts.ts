/**
 * Structured skill output proposal — parse/validate only.
 * Skills must not write DB or mutate aggregates (重构.md §7).
 */
export interface SkillProposal {
  readonly skillId: string
  readonly skillVersion: string
  readonly kind: string
  readonly payload: Readonly<Record<string, unknown>>
}
