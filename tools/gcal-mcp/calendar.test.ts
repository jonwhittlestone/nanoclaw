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
      OAuth2: mockOAuth2.mockImplementation(() => ({
        setCredentials: mockSetCredentials,
      })),
    },
    calendar: vi.fn(() => ({
      calendarList: { list: mockCalendarListList },
      events: { list: mockEventsList, get: mockEventsGet },
    })),
  },
}))

import { makeCalendarClient } from './calendar'

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