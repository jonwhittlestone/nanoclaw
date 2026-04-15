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