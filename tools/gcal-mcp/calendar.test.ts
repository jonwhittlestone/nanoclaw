import { describe, it, expect } from 'vitest'

describe('sanity', () => {
  it('vitest is running tests in tools/', () => {
    // given / when / then — always passes; proves the test file is discovered
    expect(true).toBe(true)
  })
})