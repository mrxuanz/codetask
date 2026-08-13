import assert from 'node:assert/strict'
import test from 'node:test'
import en from '../../apps/web/src/i18n/locales/en'
import ja from '../../apps/web/src/i18n/locales/ja'
import zh from '../../apps/web/src/i18n/locales/zh'

function flattenKeys(value: unknown, prefix = '', output: string[] = []): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenKeys(nested, path, output)
    } else {
      output.push(path)
    }
  }
  return output
}

test('English, Chinese, and Japanese locale trees have exact key parity', () => {
  const expected = flattenKeys(en).sort()
  assert.deepEqual(flattenKeys(zh).sort(), expected)
  assert.deepEqual(flattenKeys(ja).sort(), expected)
})
