import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
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

// Map of active SSE sessions. Each GET /sse request creates one entry.
// POST /messages routes to whichever session is active.
const transports = new Map<string, SSEServerTransport>()

// GET /sse — MCP client connects here first. Opens a persistent SSE stream.
app.get('/sse', async (req, res) => {
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

  const transport = new SSEServerTransport('/messages', res)
  await server.connect(transport)

  const id = Math.random().toString(36).slice(2)
  transports.set(id, transport)
  res.on('close', () => transports.delete(id)) // clean up on disconnect
})

// POST /messages — MCP client sends JSON-RPC calls here after connecting via /sse
app.post('/messages', express.json(), async (req, res) => {
  for (const transport of transports.values()) {
    await transport.handlePostMessage(req, res)
    return
  }
  res.status(404).send('No active session')
})

// Only start listening when run directly — not when imported by tests.
// ESM equivalent of CommonJS `require.main === module`.
import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '0.0.0.0', () => console.log(`gcal-mcp-server listening on port ${PORT}`))
}
