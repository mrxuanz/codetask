import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import type { PublicApiClient } from './api/client.ts'
import { waitJobTerminal, waitTurnTerminal } from './api/operations.ts'
import { resolveSelection } from './cases/selection.ts'
import { createTemporaryRunRoot, removeTemporaryRunRoot } from './supervisor/run-layout.ts'

test('E2E run roots are ephemeral and outside the repository', () => {
  const runId = 'test-run-root'
  const runRoot = createTemporaryRunRoot(runId)
  const parent = dirname(runRoot)
  try {
    assert.equal(relative(resolve(tmpdir()), resolve(runRoot)).startsWith('..'), false)
    assert.equal(runRoot.endsWith(runId), true)
    assert.equal(existsSync(runRoot), true)
  } finally {
    removeTemporaryRunRoot(runRoot)
  }
  assert.equal(existsSync(parent), false)
})

function inspectRgbaPng(path: URL): {
  width: number
  height: number
  visiblePixels: number
  darkPixels: number
  luminanceRange: number
} {
  const png = readFileSync(path)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')

  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8, 'fixture must use 8-bit channels')
      assert.equal(data[9], 6, 'fixture must use RGBA pixels')
      assert.equal(data[12], 0, 'fixture must be non-interlaced')
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += length + 12
  }

  assert.ok(width > 0 && height > 0 && idat.length > 0, 'fixture PNG chunks are incomplete')
  const bytesPerPixel = 4
  const rowBytes = width * bytesPerPixel
  const filtered = inflateSync(Buffer.concat(idat))
  assert.equal(filtered.length, height * (rowBytes + 1), 'fixture PNG payload is malformed')
  const pixels = Buffer.alloc(width * height * bytesPerPixel)

  const paeth = (left: number, above: number, upperLeft: number): number => {
    const estimate = left + above - upperLeft
    const leftDistance = Math.abs(estimate - left)
    const aboveDistance = Math.abs(estimate - above)
    const upperLeftDistance = Math.abs(estimate - upperLeft)
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
    return aboveDistance <= upperLeftDistance ? above : upperLeft
  }

  let sourceOffset = 0
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++]
    assert.ok(filter !== undefined && filter <= 4, `unsupported PNG filter:${filter}`)
    for (let column = 0; column < rowBytes; column += 1) {
      const target = row * rowBytes + column
      const raw = filtered[sourceOffset++] ?? 0
      const left = column >= bytesPerPixel ? pixels[target - bytesPerPixel]! : 0
      const above = row > 0 ? pixels[target - rowBytes]! : 0
      const upperLeft =
        row > 0 && column >= bytesPerPixel ? pixels[target - rowBytes - bytesPerPixel]! : 0
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft)
      pixels[target] = (raw + predictor) & 0xff
    }
  }

  let visiblePixels = 0
  let darkPixels = 0
  let minLuminance = Number.POSITIVE_INFINITY
  let maxLuminance = Number.NEGATIVE_INFINITY
  for (let index = 0; index < pixels.length; index += bytesPerPixel) {
    const red = pixels[index]!
    const green = pixels[index + 1]!
    const blue = pixels[index + 2]!
    const alpha = pixels[index + 3]!
    if (alpha < 128) continue
    visiblePixels += 1
    if (red < 50 && green < 50 && blue < 50) darkPixels += 1
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    minLuminance = Math.min(minLuminance, luminance)
    maxLuminance = Math.max(maxLuminance, luminance)
  }

  return {
    width,
    height,
    visiblePixels,
    darkPixels,
    luminanceRange: maxLuminance - minLuminance
  }
}

test('unknown --case values fail instead of reporting a skipped SUCCESS', () => {
  assert.throws(() => resolveSelection({ caseId: 'settings-mcp' }), /unknown_case:settings-mcp/)
  assert.deepEqual(resolveSelection({ caseId: 'settings-mcp-probe' }).caseIds, ['SETTINGS-MCP-001'])
})

test('image attachment case aliases resolve into phase 1/2 defaults', () => {
  assert.deepEqual(resolveSelection({ caseId: 'chat-image-attachment' }).caseIds, ['CHAT-IMG-001'])
  assert.deepEqual(resolveSelection({ caseId: 'draft-chat-image-attachment' }).caseIds, [
    'DESIGN-DRAFT-001'
  ])
  assert.deepEqual(resolveSelection({ caseId: 'draft-reference-path-job' }).caseIds, [
    'DESIGN-DRAFT-001'
  ])
  assert.deepEqual(resolveSelection({ caseId: 'notes-search' }).caseIds, ['DESIGN-DRAFT-001'])
  // legacy aliases
  assert.deepEqual(resolveSelection({ caseId: 'chat-image-ocr' }).caseIds, ['CHAT-IMG-001'])
  assert.deepEqual(resolveSelection({ caseId: 'draft-image-ocr' }).caseIds, ['DESIGN-DRAFT-001'])
  assert.deepEqual(resolveSelection({ part: 'conversation' }).caseIds, [
    'G3-001',
    'CHAT-HTML-001',
    'CHAT-IMG-001'
  ])
  assert.deepEqual(resolveSelection({ part: 'draft-job' }).caseIds, ['DESIGN-DRAFT-001'])
})

test('image attachment matcher requires contiguous phrase, not scattered tokens', async () => {
  const { recognizesImageText, normalizeAttachmentText, IMAGE_EXPECTED_TEXT } =
    await import('./oracles/image-attachment.ts')
  assert.equal(IMAGE_EXPECTED_TEXT, 'Dream of 1000 Cats')
  assert.equal(recognizesImageText('prefix Dream of 1000 Cats suffix'), true)
  assert.equal(recognizesImageText('Dream\nof\n1000\nCats'), true)
  assert.equal(recognizesImageText('dreamof1000cats'), true)
  assert.equal(recognizesImageText('Dream of many dogs and 1000 Birds'), false)
  assert.equal(recognizesImageText('Cats Dream of 1000'), false)
  assert.equal(recognizesImageText('Dream of 1OOO Cats'), false)
  assert.equal(normalizeAttachmentText('Dream of 1000 Cats'), 'dreamof1000cats')
})

test('image attachment fixture is opaque and has readable visual contrast', () => {
  const health = inspectRgbaPng(
    new URL('./fixtures/references/ocr-dream-cats.png', import.meta.url)
  )
  assert.ok(health.width >= 200 && health.height >= 200, JSON.stringify(health))
  assert.ok(health.visiblePixels >= health.width * health.height * 0.95, JSON.stringify(health))
  assert.ok(health.darkPixels >= 100, JSON.stringify(health))
  assert.ok(health.luminanceRange >= 100, JSON.stringify(health))
})

test('terminal polling survives a transient SUT fetch failure', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return {
        status: 200,
        data: { turn: { id: 'turn-1', status: 'completed' } },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  const turn = await waitTurnTerminal(client, 'thread-1', 'turn-1', 2_000)
  assert.equal(turn.status, 'completed')
  assert.equal(calls, 2)
})

test('terminal polling without timeoutMs waits until CodeTask API terminal', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      if (calls < 3) {
        return {
          status: 200,
          data: { turn: { id: 'turn-1', status: 'running' } },
          raw: {}
        }
      }
      return {
        status: 200,
        data: { turn: { id: 'turn-1', status: 'completed' } },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  const turn = await waitTurnTerminal(client, 'thread-1', 'turn-1')
  assert.equal(turn.status, 'completed')
  assert.equal(calls, 3)
})

test('terminal polling accepts ConversationTurnDto.state as terminal', async () => {
  const client = {
    async request() {
      return {
        status: 200,
        data: {
          turn: {
            id: 'turn-1',
            state: 'failed',
            lastError: { code: 'runtime.failed', message: 'lease' }
          }
        },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  const turn = await waitTurnTerminal(client, 'thread-1', 'turn-1', 2_000)
  assert.equal(turn.status, 'failed')
  assert.equal(turn.state, 'failed')
})

test('terminal polling with short timeoutMs still fails for probes', async () => {
  const client = {
    async request() {
      return {
        status: 200,
        data: { id: 'job-1', status: 'running' },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  await assert.rejects(waitJobTerminal(client, 'thread-1', 'job-1', 50), /timeout:job_job-1/)
})

test('terminal polling does not hide non-transport API failures', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      return {
        status: 500,
        data: undefined,
        raw: { message: 'broken contract' }
      }
    }
  } as unknown as PublicApiClient

  await assert.rejects(
    waitJobTerminal(client, 'thread-1', 'job-1', 2_000),
    /job\.get_failed:500:broken contract/
  )
  assert.equal(calls, 1)
})

test('E2E source has no model, executable-path, HOME, or HTML-simulation switches', () => {
  const promptSource = readFileSync(
    new URL('./drivers/opencode-prompt.ts', import.meta.url),
    'utf8'
  )
  const driverSource = readFileSync(new URL('./drivers/opencode.ts', import.meta.url), 'utf8')
  const canarySource = readFileSync(
    new URL('./drivers/opencode-canary.ts', import.meta.url),
    'utf8'
  )
  const fakeSource = readFileSync(new URL('./drivers/fake.ts', import.meta.url), 'utf8')
  const supervisorSource = readFileSync(new URL('./supervisor/main.ts', import.meta.url), 'utf8')
  const opencodeSources = `${promptSource}\n${driverSource}\n${canarySource}`

  assert.doesNotMatch(opencodeSources, /BUSINESS_OPENCODE_MODEL|CODETASK_OPENCODE_BIN|OPENCODE_BIN/)
  assert.doesNotMatch(promptSource, /\bHOME\s*:/)
  assert.doesNotMatch(promptSource, /\bmodel\s*:\s*input\./)
  assert.doesNotMatch(fakeSource, /BUSINESS_E2E_REQUIRE_AGENT_HTML|created-by=fake-driver/)
  assert.doesNotMatch(
    supervisorSource,
    /tests\/business-e2e\/\.runtime|BUSINESS_E2E_KEEP_RUNTIME|--keep-runtime/
  )
  // Draft→job authority is Design execution-profile (architecture 03), not global control-plane.
  assert.doesNotMatch(supervisorSource, /putControlPlanePolicies/)
  assert.match(supervisorSource, /draftExecutionConfigFromRoles/)
  assert.match(fakeSource, /codetask_patch_draft_execution_profile/)
  assert.match(fakeSource, /codetask_confirm_design_draft/)
  assert.doesNotMatch(fakeSource, /codetask_update_draft_execution_config/)
  assert.doesNotMatch(driverSource, /codetask_confirm_draft_final/)
  assert.match(driverSource, /DESIGN-DRAFT-001/)
})
