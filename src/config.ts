import {
  DEFAULT_BASE_URL,
  LIVE_CONVERT_TARGET_FORMATS,
  LIVE_PROFILES,
  type ConvertTargetFormat,
  type FacturxProfile,
} from '@beliq/sdk'
import { flagBool, flagStr, type ParsedArgs } from './args.js'
import { ConfigError } from './errors.js'
import type { NotifyOn } from './notify.js'

/** sevDesk default REST base. Endpoints hang off /Invoice, /Invoice/{id}/getXml. */
export const DEFAULT_SEVDESK_BASE_URL = 'https://api.sevdesk.de/api/v1'

/** sevDesk invoice status codes (Settings dropdown values), keyed by friendly name. */
const STATUS_CODES: Record<string, string> = { draft: '100', open: '200', paid: '1000' }

export interface Config {
  sevdeskToken: string
  sevdeskBaseUrl: string
  beliqApiKey: string
  beliqBaseUrl: string
  beliqAuth: 'header' | 'bearer'
  /** beliq convert targets; empty means validation-only (no conversion, no files written). */
  targetFormats: ConvertTargetFormat[]
  /** Factur-X / ZUGFeRD profile, applied only to a facturx / zugferd target. */
  targetProfile?: FacturxProfile
  /** sevDesk status code to poll, e.g. "200" for Open. */
  status: string
  /** Look-back window in days for the sevDesk date filter; 0 disables it. */
  pollWindowDays: number
  stateFile: string
  outputDir: string
  intervalSeconds: number
  pageSize: number
  maxRetries: number
  /** Run one poll and exit (vs. loop as a daemon). */
  once: boolean
  /** Walk the full pipeline (real API calls) but write no files and persist no state. */
  dryRun: boolean
  /** Webhook to POST the poll report to; undefined disables notifications. */
  notifyWebhook?: string
  /** When to notify: only when something failed, or after every poll. */
  notifyOn: NotifyOn
}

/** Read a non-empty trimmed value; flag wins over env. */
function pick(args: ParsedArgs, flag: string, env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = (flagStr(args, flag) ?? env[key])?.trim()
  return v ? v : undefined
}

function parseIntEnv(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${label} must be a non-negative integer, got "${raw}"`)
  }
  return n
}

function resolveStatus(raw: string | undefined): string {
  if (!raw) return STATUS_CODES.open
  const lower = raw.toLowerCase()
  if (lower in STATUS_CODES) return STATUS_CODES[lower]
  if (/^\d+$/.test(raw)) return raw
  throw new ConfigError(
    `invalid status "${raw}". Use Draft, Open, Paid, or a numeric sevDesk status code.`,
  )
}

function resolveTargets(raw: string | undefined): ConvertTargetFormat[] {
  if (!raw) return []
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  for (const p of parts) {
    if (!(LIVE_CONVERT_TARGET_FORMATS as readonly string[]).includes(p)) {
      throw new ConfigError(
        `invalid target format "${p}". Allowed: ${LIVE_CONVERT_TARGET_FORMATS.join(', ')}`,
      )
    }
  }
  return parts as ConvertTargetFormat[]
}

function resolveProfile(raw: string | undefined): FacturxProfile | undefined {
  if (!raw) return undefined
  if (!(LIVE_PROFILES as readonly string[]).includes(raw)) {
    throw new ConfigError(`invalid target profile "${raw}". Allowed: ${LIVE_PROFILES.join(', ')}`)
  }
  return raw as FacturxProfile
}

function resolveNotifyWebhook(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ConfigError(`invalid notify webhook URL "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`notify webhook must be an http(s) URL, got "${parsed.protocol}"`)
  }
  return raw
}

function resolveNotifyOn(raw: string | undefined): NotifyOn {
  const value = (raw ?? 'failure').trim().toLowerCase()
  if (value === 'failure' || value === 'always') return value
  throw new ConfigError(`invalid SEVDESK_NOTIFY_ON "${raw}". Use "failure" or "always".`)
}

/**
 * Resolve the typed worker config with precedence flag > env > default. Throws a
 * ConfigError (mapped to EXIT.USAGE) for a missing credential or a bad value, so
 * the worker reports a clean usage error rather than failing mid-poll. The SDK
 * reads no environment itself, so the worker owns BELIQ_* too.
 */
export function resolveConfig(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Config {
  const sevdeskToken = pick(args, 'sevdesk-token', env, 'SEVDESK_API_TOKEN')
  if (!sevdeskToken) {
    throw new ConfigError(
      'no sevDesk token. Set SEVDESK_API_TOKEN or pass --sevdesk-token (Settings -> Advanced -> API).',
    )
  }
  const beliqApiKey = pick(args, 'api-key', env, 'BELIQ_API_KEY')
  if (!beliqApiKey) {
    throw new ConfigError(
      'no beliq API key. Set BELIQ_API_KEY or pass --api-key. Create a key in the beliq dashboard under API Keys.',
    )
  }

  const beliqAuthRaw = (env.BELIQ_AUTH ?? '').trim().toLowerCase()
  const beliqAuth = beliqAuthRaw === 'bearer' ? 'bearer' : 'header'

  return {
    sevdeskToken,
    sevdeskBaseUrl: (env.SEVDESK_BASE_URL?.trim() || DEFAULT_SEVDESK_BASE_URL).replace(/\/+$/, ''),
    beliqApiKey,
    beliqBaseUrl: (env.BELIQ_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    beliqAuth,
    targetFormats: resolveTargets(flagStr(args, 'target-format') ?? env.SEVDESK_TARGET_FORMATS),
    targetProfile: resolveProfile(env.SEVDESK_TARGET_PROFILE?.trim()),
    status: resolveStatus(pick(args, 'status', env, 'SEVDESK_INVOICE_STATUS')),
    pollWindowDays: parseIntEnv(
      flagStr(args, 'poll-window-days') ?? env.SEVDESK_POLL_WINDOW_DAYS,
      30,
      'poll window (days)',
    ),
    stateFile: pick(args, 'state', env, 'SEVDESK_STATE_FILE') ?? '.beliq-sevdesk-state.json',
    outputDir: pick(args, 'output', env, 'SEVDESK_OUTPUT_DIR') ?? './out',
    intervalSeconds: parseIntEnv(
      flagStr(args, 'interval') ?? env.SEVDESK_POLL_INTERVAL_SECONDS,
      300,
      'poll interval (seconds)',
    ),
    pageSize: parseIntEnv(env.SEVDESK_PAGE_SIZE, 100, 'page size') || 100,
    maxRetries: parseIntEnv(env.SEVDESK_MAX_RETRIES, 4, 'max retries'),
    once: flagBool(args, 'once'),
    dryRun: flagBool(args, 'dry-run'),
    notifyWebhook: resolveNotifyWebhook(pick(args, 'notify-webhook', env, 'SEVDESK_NOTIFY_WEBHOOK')),
    notifyOn: resolveNotifyOn(env.SEVDESK_NOTIFY_ON),
  }
}
