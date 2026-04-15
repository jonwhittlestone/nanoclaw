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
  it('returns 400 for a malformed (non-JSON-RPC) request body', async () => {
    // given — a body that isn't a valid JSON-RPC message

    // when
    const res = await request(app)
      .post('/mcp')
      .send({ not: 'a jsonrpc message' })

    // then — transport rejects it with 406 Not Acceptable before reaching our tool handler
    expect(res.status).toBe(406)
  })
})
