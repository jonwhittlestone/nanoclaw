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
// POST /mcp
// All MCP communication goes through this single endpoint.
// The StreamableHTTP transport handles session negotiation internally.
// ==================================================================
describe('POST /mcp', () => {
  it('returns 400 with method not found for an unknown JSON-RPC method', async () => {
    // given — a valid JSON-RPC envelope but an unknown method

    // when
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'unknown/method', params: {} })

    // then — our handler returns 400 method not found
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('Method not found')
  })
})
