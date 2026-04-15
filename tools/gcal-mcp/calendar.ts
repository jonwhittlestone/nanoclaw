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