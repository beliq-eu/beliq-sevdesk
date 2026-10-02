import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'
import { EXIT } from '../src/exit.js'
import { recordingLogger } from './helpers.js'

// A live, read-only smoke against the real sevDesk + beliq APIs. Skipped unless
// both credentials are present (offline `npm test` excludes this file entirely).
// It runs --once --dry-run and validation-only, so it writes no files, persists
// no state and costs one beliq call per e-invoice. The sevDesk account has to
// hold at least one Open e-invoice: a run that sees none has checked nothing,
// and this test fails rather than pass on it.
// Run with: SEVDESK_API_TOKEN=... BELIQ_API_KEY=... npm run test:integration
const hasCreds = Boolean(process.env.SEVDESK_API_TOKEN && process.env.BELIQ_API_KEY)

describe.skipIf(!hasCreds)('live smoke (dry-run)', () => {
  it('gets a verdict for every e-invoice in the account, and none errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beliq-sevdesk-live-'))
    const r = recordingLogger()
    try {
      const code = await main(['--once', '--dry-run', '--poll-window-days', '0'], r.log, {
        ...process.env,
        SEVDESK_TARGET_FORMATS: '',
        SEVDESK_STATE_FILE: join(dir, 'state.json'),
      })

      expect(r.eventsNamed('invoice.error').map((e) => e.fields)).toEqual([])
      expect(r.eventsNamed('validate.refused').map((e) => e.fields)).toEqual([])
      const verdicts = r.eventsNamed('validate')
      expect(verdicts.length, 'the sevDesk account holds no Open e-invoice').toBeGreaterThan(0)
      // Every verdict comes from the real rule stack and is one of the two.
      expect(verdicts.every((e) => typeof e.fields?.valid === 'boolean')).toBe(true)
      expect([EXIT.OK, EXIT.INVALID]).toContain(code)
      expect(r.summaries.join('\n')).toMatch(/processed \d+ invoice\(s\): \d+ valid, \d+ invalid, 0 error, \d+ skipped/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
