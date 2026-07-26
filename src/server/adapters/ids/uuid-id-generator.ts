import { randomUUID } from 'node:crypto'
import type { IdGenerator } from '../../core/application/ports/id-generator'

export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID()
  }
}
