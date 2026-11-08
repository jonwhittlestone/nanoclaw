import { google } from 'googleapis'

// Creates an authenticated Google Calendar client.
// Env vars are read here (not at module load) so tests can set them in beforeEach.
export function makeCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GCAL_CLIENT_ID!,
    process.env.GCAL_CLIENT_SECRET!,
  )
  auth.setCredentials({ refresh_token: process.env.GCAL_REFRESH_TOKEN! })
  return google.calendar({ version: 'v3', auth })
}

// Tool argument type — args arrive as unknown values from the MCP protocol.
// We cast to the expected type at the point of use.
type Args = Record<string, unknown>

export async function handleTool(name: string, args: Args): Promise<unknown> {
  const cal = makeCalendarClient()

  if (name === 'list_calendars') {
    // Fetch every calendar visible to this Google account, including shared ones
    const res = await cal.calendarList.list()
    const items = res.data.items ?? []
    // Return a slim projection — only the fields the agent needs to pick a calendar
    return items.map(c => ({
      id: c.id,
      summary: c.summary,
      primary: c.primary ?? false,
      accessRole: c.accessRole,
    }))
  }

  if (name === 'list_events') {
    const calendarId = (args.calendarId as string) ?? 'primary'
    const now = new Date()
    // Default window: now → +7 days. Can be overridden by the agent.
    const timeMin = (args.timeMin as string) ?? now.toISOString()
    const timeMax = (args.timeMax as string) ?? new Date(now.getTime() + 7 * 86400000).toISOString()

    const res = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      // Clamp to 100 — the Google Calendar API hard limit
      maxResults: Math.min((args.maxResults as number) ?? 20, 100),
      singleEvents: true,    // expand recurring events into individual instances
      orderBy: 'startTime',  // chronological order
      q: (args.query as string) ?? undefined,
    })

    return (res.data.items ?? []).map(e => ({
      id: e.id,
      summary: e.summary,
      // dateTime is used for timed events; date for all-day events
      start: e.start?.dateTime ?? e.start?.date,
      end:   e.end?.dateTime   ?? e.end?.date,
      location: e.location,
      // Trim description to avoid flooding the agent context window
      description: e.description?.slice(0, 200),
      status: e.status,
      htmlLink: e.htmlLink,
    }))
  }

  if (name === 'get_event') {
    // Return the full event object — caller asked for details, give it everything
    const res = await cal.events.get({
      calendarId: args.calendarId as string,
      eventId:    args.eventId    as string,
    })
    return res.data
  }

  // Reaching here means the MCP server was called with a tool we don't implement.
  // Throwing causes the MCP layer to return isError: true to the agent.
  throw new Error(`Unknown tool: ${name}`)
}