import { vi, describe, it, expect, beforeEach } from 'vitest'
describe('sanity', () => {
  it('vitest is running tests in tools/', () => {
    // given / when / then — always passes; proves the test file is discovered
    expect(true).toBe(true)
  })
})


// ------------------------------------------------------------------
// Mock googleapis — prevents real HTTP calls during tests.
// Python equivalent: @patch('mymodule.google') in pytest.
//
// vi.hoisted() ensures these mock functions are created before
// vi.mock() runs. vitest hoists vi.mock() calls to the top of the
// file at compile time, so plain `const` declarations above them
// would be undefined at that point — vi.hoisted() solves that.
// ------------------------------------------------------------------
const { mockSetCredentials, mockOAuth2, mockCalendarListList, mockEventsList, mockEventsGet } =
  vi.hoisted(() => ({
    mockSetCredentials: vi.fn(),
    mockOAuth2: vi.fn(),
    mockCalendarListList: vi.fn(),
    mockEventsList: vi.fn(),
    mockEventsGet: vi.fn(),
  }))

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: mockOAuth2.mockImplementation(function () {
        return { setCredentials: mockSetCredentials }
      }),
    },
    calendar: vi.fn(() => ({
      calendarList: { list: mockCalendarListList },
      events: { list: mockEventsList, get: mockEventsGet },
    })),
  },
}))

import { makeCalendarClient, handleTool } from './calendar'

// Reset all mock call counts before each test
beforeEach(() => {
  vi.clearAllMocks()
  process.env.GCAL_CLIENT_ID = 'test-client-id'
  process.env.GCAL_CLIENT_SECRET = 'test-client-secret'
  process.env.GCAL_REFRESH_TOKEN = 'test-refresh-token'
})

// ==================================================================
// makeCalendarClient()
// Creates an authenticated Google Calendar API client from env vars.
// ==================================================================
describe('makeCalendarClient', () => {
  it('creates an OAuth2 client using GCAL_CLIENT_ID and GCAL_CLIENT_SECRET', () => {
    // given — env vars are set in beforeEach

    // when
    makeCalendarClient()

    // then — OAuth2 constructor called with the right credentials
    expect(mockOAuth2).toHaveBeenCalledWith('test-client-id', 'test-client-secret')
  })

  it('attaches the refresh token to the OAuth2 client', () => {
    // given — env vars are set in beforeEach

    // when
    makeCalendarClient()

    // then — setCredentials called with the refresh token
    expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'test-refresh-token' })
  })
})

// ==================================================================
// handleTool('list_calendars')
// Returns every calendar visible to this Google account — includes
// calendars shared with you (e.g. whittlestonefamily@gmail.com).
// ==================================================================
describe("handleTool('list_calendars')", () => {
  it('returns id, summary, primary flag, and accessRole for each calendar', async () => {
    // given — the API returns two calendars
    mockCalendarListList.mockResolvedValue({
      data: {
        items: [
          { id: 'primary', summary: 'Jon Whittlestone', primary: true, accessRole: 'owner' },
          { id: 'family@group.calendar.google.com', summary: 'Whittlestone Family', primary: false, accessRole: 'reader' },
        ],
      },
    })

    // when
    const result = await handleTool('list_calendars', {})

    // then — slim projection returned (not the full API response object)
    expect(result).toEqual([
      { id: 'primary', summary: 'Jon Whittlestone', primary: true, accessRole: 'owner' },
      { id: 'family@group.calendar.google.com', summary: 'Whittlestone Family', primary: false, accessRole: 'reader' },
    ])
  })

  it('returns an empty array when the API returns no items', async () => {
    // given — edge case: account with no calendars (or API returns undefined)
    mockCalendarListList.mockResolvedValue({ data: { items: undefined } })

    // when / then
    expect(await handleTool('list_calendars', {})).toEqual([])
  })
})

// ==================================================================
// handleTool('list_events')
// Fetches events from a calendar within a time window.
// Defaults: calendarId='primary', window=now→+7days, maxResults=20.
// ==================================================================
describe("handleTool('list_events')", () => {
  it('forwards calendarId and date range to the API', async () => {
    // given
    mockEventsList.mockResolvedValue({ data: { items: [] } })
    const args = {
      calendarId: 'family@group.calendar.google.com',
      timeMin: '2026-04-15T00:00:00Z',
      timeMax: '2026-04-22T00:00:00Z',
    }

    // when
    await handleTool('list_events', args)

    // then — exact args forwarded to the API
    expect(mockEventsList).toHaveBeenCalledWith(expect.objectContaining({
      calendarId: 'family@group.calendar.google.com',
      timeMin: '2026-04-15T00:00:00Z',
      timeMax: '2026-04-22T00:00:00Z',
    }))
  })

  it('defaults calendarId to "primary" when not provided', async () => {
    // given
    mockEventsList.mockResolvedValue({ data: { items: [] } })

    // when
    await handleTool('list_events', {})

    // then
    expect(mockEventsList).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'primary' }))
  })

  it('caps maxResults at 100 regardless of what the caller requests', async () => {
    // given
    mockEventsList.mockResolvedValue({ data: { items: [] } })

    // when
    await handleTool('list_events', { maxResults: 999 })

    // then — Google Calendar API hard limit is 100; exceeding it returns an error
    expect(mockEventsList).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 100 }))
  })

  it('returns a formatted event object for each item', async () => {
    // given
    mockEventsList.mockResolvedValue({
      data: {
        items: [{
          id: 'evt1',
          summary: 'Team standup',
          start: { dateTime: '2026-04-15T09:00:00Z' },
          end:   { dateTime: '2026-04-15T09:15:00Z' },
          location: 'Google Meet',
          description: 'Daily sync',
          status: 'confirmed',
          htmlLink: 'https://calendar.google.com/event?eid=abc',
        }],
      },
    })

    // when
    const result = await handleTool('list_events', {}) as any[]

    // then — formatted projection (not raw API response)
    expect(result[0]).toMatchObject({
      id: 'evt1',
      summary: 'Team standup',
      start: '2026-04-15T09:00:00Z',
      end:   '2026-04-15T09:15:00Z',
      location: 'Google Meet',
    })
  })
})
// ==================================================================
// handleTool('get_event')
// Fetches full details of a single event by calendarId + eventId.
// Used as a follow-up when list_events returns something interesting.
// ==================================================================
describe("handleTool('get_event')", () => {
  it('passes calendarId and eventId verbatim to the API', async () => {
    // given
    mockEventsGet.mockResolvedValue({ data: { id: 'evt1', summary: 'Dentist' } })

    // when
    await handleTool('get_event', { calendarId: 'primary', eventId: 'evt1' })

    // then — both IDs forwarded exactly as provided (no defaulting)
    expect(mockEventsGet).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt1' })
  })

  it('returns the full raw API response (unlike list_events which projects fields)', async () => {
    // given
    const fullEvent = { id: 'evt1', summary: 'Dentist', description: 'Crown fitting', attendees: [] }
    mockEventsGet.mockResolvedValue({ data: fullEvent })

    // when
    const result = await handleTool('get_event', { calendarId: 'primary', eventId: 'evt1' })

    // then — get_event returns everything; the agent asked for details
    expect(result).toEqual(fullEvent)
  })
})
