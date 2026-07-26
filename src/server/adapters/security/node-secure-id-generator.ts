import { randomUUID } from 'node:crypto'
import type { IdGenerator } from '../../core/application/ports'

export class NodeSecureIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID()
  }
}
