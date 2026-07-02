import { describe, it, expect } from 'vitest'
import { main } from '../src/cli.js'
import { recordingLogger } from './helpers.js'

// A live, read-only smoke against the real sevDesk + beliq APIs. Skipped unless
// both credentials are present (offline `npm test` excludes this file entirely).
// It runs --once --dry-run so it writes no files and persists no state: it lists
// invoices, pulls each one's XML, converts + validates, and asserts a clean exit
// contract. Run with: SEVDESK_API_TOKEN=... BELIQ_API_KEY=... npm run test:integration
const hasCreds = Boolean(process.env.SEVDESK_API_TOKEN && process.env.BELIQ_API_KEY)

describe.skipIf(!hasCreds)('live smoke (dry-run)', () => {
  it('walks the pipeline and returns a defined exit code', async () => {
    const r = recordingLogger()
    const code = await main(
      ['--once', '--dry-run', '--poll-window-days', '3650'],
      r.log,
      process.env,
    )
    // 0 valid, 1 an invalid document, 3 an API/pipeline error - all are a
    // successful walk of the contract; only an unexpected crash would differ.
    expect([0, 1, 3]).toContain(code)
    expect(r.events.some((e) => e.event === 'poll')).toBe(true)
    expect(r.summaries.join('\n')).toMatch(/processed \d+ invoice/)
  })
})
