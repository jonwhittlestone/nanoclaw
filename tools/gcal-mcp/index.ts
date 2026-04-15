import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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

// POST /mcp — single endpoint for all MCP communication (StreamableHTTP transport).
// Replaces the old /sse + /messages pattern. Each request gets its own stateless
// transport instance; the MCP SDK handles session negotiation internally.
app.post('/mcp', async (req, res) => {
  const server = new Server(
    { name: 'google-calendar', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // Agent asks: "what tools do you have?"
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  // Agent calls a tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await handleTool(name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      // isError: true signals to the agent that the tool failed — it can decide how to recover
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true }
    }
  })

  // Stateless mode: no sessionIdGenerator — each POST is self-contained.
  // Suitable for a single-user local server; no sticky sessions needed.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

// Only start listening when run directly — not when imported by tests.
// ESM equivalent of CommonJS `require.main === module`.
import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '0.0.0.0', () => console.log(`gcal-mcp-server listening on port ${PORT}`))
}
