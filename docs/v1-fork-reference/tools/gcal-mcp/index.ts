import express from 'express'
import { handleTool } from './calendar'

const PORT = parseInt(process.env.GCAL_MCP_PORT ?? '3020', 10)

// MCP tool definitions — tells the agent what tools exist and their input shapes.
// The agent uses these to decide which tool to call and with what arguments.
const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List all calendars the user has access to, including shared calendars.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_events',
    description: 'List upcoming events from one or more calendars.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (from list_calendars). Defaults to "primary".' },
        timeMin:    { type: 'string', description: 'Start time in ISO 8601 format. Defaults to now.' },
        timeMax:    { type: 'string', description: 'End time in ISO 8601 format. Defaults to 7 days from now.' },
        maxResults: { type: 'number', description: 'Max events to return (default 20, max 100).' },
        query:      { type: 'string', description: 'Free-text search query to filter events.' },
      },
      required: [],
    },
  },
  {
    name: 'get_event',
    description: 'Get full details of a specific calendar event.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID containing the event.' },
        eventId:    { type: 'string', description: 'Event ID (from list_events).' },
      },
      required: ['calendarId', 'eventId'],
    },
  },
]

// Exported so index.test.ts can import it without starting the server
export const app = express()
app.use(express.json())

// POST /mcp — MCP Streamable HTTP transport, implemented directly as JSON-RPC.
//
// We bypass StreamableHTTPServerTransport because it requires
// Accept: application/json, text/event-stream, which the Claude Agent SDK
// (type: 'http') does not send. Direct JSON-RPC handling avoids that check
// while remaining fully compatible with the MCP protocol.
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body ?? {}

  // MCP initialize — client announces itself, server returns capabilities
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'google-calendar', version: '1.0.0' },
      },
    })
  }

  // MCP notifications (e.g. notifications/initialized) — no response needed
  if (method?.startsWith('notifications/')) {
    return res.status(204).end()
  }

  // tools/list — agent asks what tools are available
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    })
  }

  // tools/call — agent invokes a tool
  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {}
    try {
      const result = await handleTool(name, (args ?? {}) as Record<string, unknown>)
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      })
    } catch (err) {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        },
      })
    }
  }

  // Unknown method
  res.status(400).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  })
})

// Only start listening when run directly — not when imported by tests.
// ESM equivalent of CommonJS `require.main === module`.
import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '0.0.0.0', () => console.log(`gcal-mcp-server listening on port ${PORT}`))
}
