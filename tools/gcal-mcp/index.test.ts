import { vi, describe, it, expect } from 'vitest'
import request from 'supertest'

// Mock calendar.ts so this test doesn't need real credentials
vi.mock('./calendar', () => ({
  makeCalendarClient: vi.fn(),
  handleTool: vi.fn(),
}))

// Import app after mock (vi.mock is hoisted — same pattern as calendar.test.ts)
import { app } from './index'

// ==================================================================
// POST /messages
// MCP clients POST JSON-RPC messages here after connecting via /sse.
// If no SSE session is active, the server must reject the request.
// ==================================================================
describe('POST /messages', () => {
  it('returns 404 with "No active session" when no SSE client is connected', async () => {
    // given — no client has connected to /sse (transports map is empty)

    // when
    const res = await request(app)
      .post('/messages')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })

    // then
    expect(res.status).toBe(404)
    expect(res.text).toBe('No active session')
  })
})

// Note: GET /sse is not unit-tested — it opens a persistent SSE stream
// which doesn't fit request/response testing. Verified end-to-end in Part 6:
//   curl -s http://localhost:3020/sse
