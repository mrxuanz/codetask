import type { Clock } from '../../core/application/ports/clock'

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
