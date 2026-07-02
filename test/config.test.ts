import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/args.js'
import { resolveConfig, DEFAULT_SEVDESK_BASE_URL } from '../src/config.js'
import { ConfigError } from '../src/errors.js'

const BASE_ENV = {
  SEVDESK_API_TOKEN: 'sk-sevdesk',
  BELIQ_API_KEY: 'bk-beliq',
} as NodeJS.ProcessEnv

const cfg = (argv: string[], env: NodeJS.ProcessEnv = BASE_ENV) => resolveConfig(parseArgs(argv), env)

describe('resolveConfig credentials', () => {
  it('requires a sevDesk token', () => {
    expect(() => cfg([], { BELIQ_API_KEY: 'x' } as NodeJS.ProcessEnv)).toThrow(/no sevDesk token/)
  })

  it('requires a beliq API key', () => {
    expect(() => cfg([], { SEVDESK_API_TOKEN: 'x' } as NodeJS.ProcessEnv)).toThrow(/no beliq API key/)
  })

  it('takes credentials from flags over env', () => {
    const c = cfg(['--sevdesk-token', 'flag-tok', '--api-key', 'flag-key'])
    expect(c.sevdeskToken).toBe('flag-tok')
    expect(c.beliqApiKey).toBe('flag-key')
  })
})

describe('resolveConfig defaults', () => {
  it('applies documented defaults', () => {
    const c = cfg([])
    expect(c.status).toBe('200')
    expect(c.pollWindowDays).toBe(30)
    expect(c.stateFile).toBe('.beliq-sevdesk-state.json')
    expect(c.outputDir).toBe('./out')
    expect(c.intervalSeconds).toBe(300)
    expect(c.pageSize).toBe(100)
    expect(c.maxRetries).toBe(4)
    expect(c.sevdeskBaseUrl).toBe(DEFAULT_SEVDESK_BASE_URL)
    expect(c.beliqAuth).toBe('header')
    expect(c.targetFormats).toEqual([])
    expect(c.once).toBe(false)
    expect(c.dryRun).toBe(false)
    expect(c.notifyWebhook).toBeUndefined()
    expect(c.notifyOn).toBe('failure')
  })
})

describe('resolveConfig notify', () => {
  it('takes the webhook from the flag over env', () => {
    const c = cfg(['--notify-webhook', 'https://flag.example/hook'], {
      ...BASE_ENV,
      SEVDESK_NOTIFY_WEBHOOK: 'https://env.example/hook',
    })
    expect(c.notifyWebhook).toBe('https://flag.example/hook')
  })

  it('rejects a non-URL webhook', () => {
    expect(() => cfg(['--notify-webhook', 'not a url'])).toThrow(/invalid notify webhook/)
  })

  it('rejects a non-http(s) webhook scheme', () => {
    expect(() => cfg(['--notify-webhook', 'ftp://example.com/hook'])).toThrow(/http\(s\)/)
  })

  it('accepts notify-on = always', () => {
    expect(cfg([], { ...BASE_ENV, SEVDESK_NOTIFY_ON: 'always' }).notifyOn).toBe('always')
  })

  it('rejects an unknown notify-on', () => {
    expect(() => cfg([], { ...BASE_ENV, SEVDESK_NOTIFY_ON: 'sometimes' })).toThrow(/SEVDESK_NOTIFY_ON/)
  })
})

describe('resolveConfig status', () => {
  it('maps friendly names to sevDesk codes', () => {
    expect(cfg(['--status', 'Draft']).status).toBe('100')
    expect(cfg(['--status', 'open']).status).toBe('200')
    expect(cfg(['--status', 'PAID']).status).toBe('1000')
  })

  it('passes a numeric code through', () => {
    expect(cfg(['--status', '750']).status).toBe('750')
  })

  it('rejects an unknown status', () => {
    expect(() => cfg(['--status', 'archived'])).toThrow(ConfigError)
  })
})

describe('resolveConfig target formats', () => {
  it('parses and trims a CSV list', () => {
    expect(cfg(['--target-format', ' peppol-bis , ubl ']).targetFormats).toEqual(['peppol-bis', 'ubl'])
  })

  it('lets a flag override the env list', () => {
    const c = cfg(['--target-format', 'ubl'], { ...BASE_ENV, SEVDESK_TARGET_FORMATS: 'cii,zugferd' })
    expect(c.targetFormats).toEqual(['ubl'])
  })

  it('rejects an unknown target format', () => {
    expect(() => cfg(['--target-format', 'ubl,bogus'])).toThrow(/invalid target format/)
  })
})

describe('resolveConfig profile and window', () => {
  it('validates a target profile', () => {
    expect(cfg([], { ...BASE_ENV, SEVDESK_TARGET_PROFILE: 'en16931' }).targetProfile).toBe('en16931')
  })

  it('rejects an unknown profile', () => {
    expect(() => cfg([], { ...BASE_ENV, SEVDESK_TARGET_PROFILE: 'gold' })).toThrow(/invalid target profile/)
  })

  it('rejects a non-integer poll window', () => {
    expect(() => cfg(['--poll-window-days', 'soon'])).toThrow(ConfigError)
  })

  it('allows disabling the window with 0', () => {
    expect(cfg(['--poll-window-days', '0']).pollWindowDays).toBe(0)
  })
})
