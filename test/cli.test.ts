import { describe, it, expect } from 'vitest'
import { main } from '../src/cli.js'
import { recordingLogger } from './helpers.js'

// main() builds real clients only after config resolves, so every path here is
// network-free: help/version and every config/usage error return first. An empty
// env guarantees no ambient credentials.
const NO_ENV = {} as NodeJS.ProcessEnv
const errText = (r: ReturnType<typeof recordingLogger>) =>
  r.events.filter((e) => e.level === 'error').map((e) => String(e.fields?.message)).join('\n')

describe('main (network-free paths)', () => {
  it('prints help for --help and returns 0', async () => {
    const r = recordingLogger()
    expect(await main(['--help'], r.log, NO_ENV)).toBe(0)
    expect(r.summaries.join('\n')).toContain('Usage:')
  })

  it('prints a version for --version', async () => {
    const r = recordingLogger()
    expect(await main(['--version'], r.log, NO_ENV)).toBe(0)
    expect(r.summaries.join('\n').trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns a usage error (2) when the sevDesk token is missing', async () => {
    const r = recordingLogger()
    expect(await main(['--once'], r.log, NO_ENV)).toBe(2)
    expect(errText(r)).toContain('no sevDesk token')
  })

  it('returns a usage error (2) when the beliq key is missing', async () => {
    const r = recordingLogger()
    expect(await main(['--once'], r.log, { SEVDESK_API_TOKEN: 'x' } as NodeJS.ProcessEnv)).toBe(2)
    expect(errText(r)).toContain('no beliq API key')
  })

  it('returns a usage error (2) for an unknown option', async () => {
    const r = recordingLogger()
    expect(await main(['--nope'], r.log, NO_ENV)).toBe(2)
    expect(errText(r)).toContain('unknown option')
  })

  it('returns a usage error (2) for a bad target format', async () => {
    const r = recordingLogger()
    const env = { SEVDESK_API_TOKEN: 'x', BELIQ_API_KEY: 'y' } as NodeJS.ProcessEnv
    expect(await main(['--once', '--target-format', 'bogus'], r.log, env)).toBe(2)
    expect(errText(r)).toContain('invalid target format')
  })
})
