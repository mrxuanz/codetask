import {
  planEditorSkillDescriptor,
  plannerSkillDescriptor
} from '../../skills/builtins/index'

export interface SkillDescriptor {
  readonly id: string
  readonly version: string
  readonly role?: string
}

export interface SkillCatalog {
  get(id: string): SkillDescriptor | undefined
  list(): readonly SkillDescriptor[]
}

/** Empty catalog — tests that need no skills. */
export class EmptySkillCatalog implements SkillCatalog {
  get(_id: string): SkillDescriptor | undefined {
    return undefined
  }

  list(): readonly SkillDescriptor[] {
    return []
  }
}

const BUILTIN_DESCRIPTORS: readonly SkillDescriptor[] = [
  plannerSkillDescriptor,
  planEditorSkillDescriptor
]

/** Registers Wave 5 builtin skills (planner + plan-editor stub). */
export class BuiltinSkillCatalog implements SkillCatalog {
  private readonly byId = new Map<string, SkillDescriptor>(
    BUILTIN_DESCRIPTORS.map((d) => [d.id, d])
  )

  get(id: string): SkillDescriptor | undefined {
    return this.byId.get(id)
  }

  list(): readonly SkillDescriptor[] {
    return [...this.byId.values()]
  }
}
