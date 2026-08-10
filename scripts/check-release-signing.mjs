#!/usr/bin/env node

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? (process.argv[platformIndex + 1] ?? '') : ''

function requireValues(names) {
  const missing = names.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`release_signing.missing:${platform}:${missing.join(',')}`)
  }
}

if (platform.startsWith('macos-')) {
  requireValues([
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID'
  ])
} else if (platform.startsWith('windows-')) {
  requireValues(['CSC_LINK', 'CSC_KEY_PASSWORD'])
} else if (!platform.startsWith('linux-')) {
  throw new Error(`release_signing.invalid_platform:${platform}`)
}
