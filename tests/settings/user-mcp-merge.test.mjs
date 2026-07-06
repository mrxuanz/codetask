import assert from 'node:assert/strict'
import test from 'node:test'

const CODETEAM_MANAGER = 'codeteam-manager'

function buildClaudeMcpServers(url, userMcpServers = {}) {
  const merged = { ...userMcpServers }
  if (url) merged[CODETEAM_MANAGER] = { type: 'http', url }
  return merged
}

function listMergedMcpServerNames(systemMcpUrl, userMcpServers) {
  const names = Object.keys(userMcpServers)
  if (systemMcpUrl) names.push(CODETEAM_MANAGER)
  return names
}

test('role-scoped user MCP merges with system MCP', () => {
  const userMcpServers = {
    docs: { type: 'http', url: 'http://127.0.0.1:9/mcp' }
  }
  const merged = buildClaudeMcpServers('http://127.0.0.1:1/mcp', userMcpServers)
  assert.equal(Object.keys(merged).length, 2)
  assert.equal(merged.docs.url, 'http://127.0.0.1:9/mcp')
  assert.equal(merged[CODETEAM_MANAGER].url, 'http://127.0.0.1:1/mcp')
})

test('listMergedMcpServerNames includes user and system servers', () => {
  const names = listMergedMcpServerNames('http://127.0.0.1:1/mcp', {
    docs: { type: 'http', url: 'http://127.0.0.1:9/mcp' }
  })
  assert.deepEqual(names, ['docs', CODETEAM_MANAGER])
})

test('native codex fragment shape uses mcp_servers root key', () => {
  const fragment = {
    mcp_servers: {
      docs: { url: 'http://127.0.0.1:9/mcp' }
    }
  }
  assert.ok('mcp_servers' in fragment)
  assert.equal(fragment.mcp_servers.docs.url, 'http://127.0.0.1:9/mcp')
})
