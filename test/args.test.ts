import { describe, it, expect } from 'vitest'
import { parseArgs, flagBool, flagStr } from '../src/args.js'
import { ConfigError } from '../src/errors.js'

describe('parseArgs', () => {
  it('parses boolean flags', () => {
    const args = parseArgs(['--once', '--dry-run'])
    expect(flagBool(args, 'once')).toBe(true)
    expect(flagBool(args, 'dry-run')).toBe(true)
  })

  it('parses a value flag with a separate token', () => {
    const args = parseArgs(['--target-format', 'ubl,cii'])
    expect(flagStr(args, 'target-format')).toBe('ubl,cii')
  })

  it('parses a value flag with inline =', () => {
    const args = parseArgs(['--state=/tmp/s.json', '--status=Open'])
    expect(flagStr(args, 'state')).toBe('/tmp/s.json')
    expect(flagStr(args, 'status')).toBe('Open')
  })

  it('sets help and version', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ConfigError)
  })

  it('rejects a positional argument', () => {
    expect(() => parseArgs(['run'])).toThrow(ConfigError)
  })

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['--target-format'])).toThrow(ConfigError)
  })

  it('rejects a value on a boolean flag', () => {
    expect(() => parseArgs(['--once=1'])).toThrow(ConfigError)
  })
})
