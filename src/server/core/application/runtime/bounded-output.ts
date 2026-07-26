/**
 * Ring-buffer stdout/stderr capture (重构.md §10.8).
 * Never grows without bound — retains the most recent `capacityBytes`.
 */

export interface BoundedOutput {
  readonly bytesSeen: number
  readonly bytesRetained: number
  readonly truncated: boolean
  tail(): Buffer
}

export class BoundedOutputBuffer implements BoundedOutput {
  private readonly chunks: Buffer[] = []
  private _bytesSeen = 0
  private _bytesRetained = 0
  private _truncated = false

  constructor(private readonly capacityBytes: number) {
    if (capacityBytes <= 0) {
      throw new Error('BoundedOutput capacityBytes must be > 0')
    }
  }

  get bytesSeen(): number {
    return this._bytesSeen
  }

  get bytesRetained(): number {
    return this._bytesRetained
  }

  get truncated(): boolean {
    return this._truncated
  }

  append(chunk: Buffer | string | Uint8Array): void {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk)
    if (buf.length === 0) return

    this._bytesSeen += buf.length
    this.chunks.push(buf)
    this._bytesRetained += buf.length

    while (this._bytesRetained > this.capacityBytes && this.chunks.length > 0) {
      const head = this.chunks[0]!
      const overflow = this._bytesRetained - this.capacityBytes
      if (head.length <= overflow) {
        this.chunks.shift()
        this._bytesRetained -= head.length
        this._truncated = true
      } else {
        this.chunks[0] = head.subarray(overflow)
        this._bytesRetained -= overflow
        this._truncated = true
        break
      }
    }
  }

  /** Most recent retained bytes (tail of the stream). */
  tail(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0)
    return Buffer.concat(this.chunks)
  }
}

export function createBoundedOutput(capacityBytes: number): BoundedOutputBuffer {
  return new BoundedOutputBuffer(capacityBytes)
}
