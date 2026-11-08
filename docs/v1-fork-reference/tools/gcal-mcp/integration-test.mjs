/**
 * Integration test for the gcal-mcp server (StreamableHTTP transport).
 *
 * Requires the server to be running:
 *   npx tsx tools/gcal-mcp/index.ts
 *
 * Usage:
 *   node tools/gcal-mcp/integration-test.mjs
 */

const BASE = 'http://localhost:3020'
let id = 1
const nextId = () => id++

async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params }),
  })

  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()

  if (!res.ok) throw new Error(`${method} failed: ${res.status} — ${text}`)

  // StreamableHTTP can respond as plain JSON or as an SSE stream
  if (contentType.includes('application/json')) {
    return JSON.parse(text)
  }

  // SSE response: parse the first data: line
  const dataLine = text.split('\n').find(l => l.startsWith('data:'))
  if (!dataLine) throw new Error(`No data in SSE response for ${method}`)
  return JSON.parse(dataLine.slice('data:'.length).trim())
}

async function main() {
  console.log('Connecting to gcal-mcp server at', BASE)

  // 1. Initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'integration-test', version: '1.0.0' },
  })
  console.log('\n[1] initialize →', init.result?.serverInfo ?? init)

  // 2. List tools
  const toolsRes = await rpc('tools/list')
  const tools = toolsRes.result?.tools ?? []
  console.log('\n[2] tools/list →', tools.map(t => t.name))

  // 3. Call list_calendars — hits the real Google Calendar API
  console.log('\n[3] tools/call list_calendars ...')
  const calRes = await rpc('tools/call', { name: 'list_calendars', arguments: {} })
  const content = calRes.result?.content?.[0]?.text
  if (!content) throw new Error('No content in list_calendars response')

  const calendars = JSON.parse(content)
  console.log('\nCalendars:')
  calendars.forEach(c => console.log(`  ${c.primary ? '★' : ' '} ${c.summary} (${c.id}) [${c.accessRole}]`))

  console.log('\nIntegration test passed.')
}

main().catch(err => {
  console.error('\nError:', err.message)
  process.exit(1)
})
