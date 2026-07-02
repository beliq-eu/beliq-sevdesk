import { describe, it, expect } from 'vitest'
import { EXIT, emptyCounts, summaryExitCode } from '../src/exit.js'

describe('summaryExitCode', () => {
  it('is OK when nothing failed', () => {
    expect(summaryExitCode({ valid: 3, invalid: 0, error: 0 })).toBe(EXIT.OK)
  })

  it('is OK for an empty run', () => {
    expect(summaryExitCode(emptyCounts())).toBe(EXIT.OK)
  })

  it('is INVALID when a document failed validation', () => {
    expect(summaryExitCode({ valid: 1, invalid: 2, error: 0 })).toBe(EXIT.INVALID)
  })

  it('is API when an invoice errored', () => {
    expect(summaryExitCode({ valid: 1, invalid: 0, error: 1 })).toBe(EXIT.API)
  })

  it('lets an error outrank an invalid (an unknown verdict is worse than a known bad one)', () => {
    expect(summaryExitCode({ valid: 0, invalid: 5, error: 1 })).toBe(EXIT.API)
  })
})
