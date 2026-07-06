const addon = require('.')
const payload = process.argv[2]
if (!payload) {
  console.error('setup-entry: missing payload argument')
  process.exit(1)
}
addon.runSetupHelper(payload)
