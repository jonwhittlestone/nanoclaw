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
}