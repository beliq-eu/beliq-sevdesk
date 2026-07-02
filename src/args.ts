import { ConfigError } from './errors.js'

export interface ParsedArgs {
  flags: Record<string, string | boolean>
  help: boolean
  version: boolean
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['once', 'dry-run'])

/**
 * Flags that take a value and override the matching environment variable. The
 * worker is env-first (it runs as a container / cron job); these are the handful
 * worth tweaking per invocation. Everything else stays env-only (see config.ts).
 */
const VALUE_FLAGS = new Set([
  'state',
  'output',
  'target-format',
  'status',
  'poll-window-days',
  'interval',
  'api-key',
  'sevdesk-token',
  'notify-webhook',
])

/**
 * Parse argv into flags. Hand-rolled (no dependency): the surface is small and
 * this stays pure and unit-testable. Unknown flags and any positional argument
 * are usage errors.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { flags: {}, help: false, version: false }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--help' || token === '-h') {
      out.help = true
      continue
    }
    if (token === '--version' || token === '-v') {
      out.version = true
      continue
    }

    if (!token.startsWith('--')) {
      throw new ConfigError(`unexpected argument "${token}". Run beliq-sevdesk --help.`)
    }

    const body = token.slice(2)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new ConfigError(`option --${name} takes no value`)
      out.flags[name] = true
    } else if (VALUE_FLAGS.has(name)) {
      let value = inlineValue
      if (value === undefined) {
        value = argv[++i]
        if (value === undefined) throw new ConfigError(`option --${name} needs a value`)
      }
      out.flags[name] = value
    } else {
      throw new ConfigError(`unknown option --${name}`)
    }
  }

  return out
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}
