import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export function version(): string {
  const pkg = require('../package.json') as { version: string }
  return pkg.version
}

export const HELP = `beliq-sevdesk: poll sevDesk invoices, convert them, and validate them with beliq

Usage:
  beliq-sevdesk [--once] [--dry-run] [options]

Runs a poll loop by default. With --once it polls a single time and exits with a
code you can gate CI or cron on (see below). Configuration is read from the
environment; the flags below override the matching variable.

Options:
  --once                    poll once and exit (default: loop as a daemon)
  --dry-run                 walk the full pipeline but write no files and persist no state
  --target-format <csv>     beliq convert targets, comma-separated (default: SEVDESK_TARGET_FORMATS)
  --status <s>              Draft | Open | Paid, or a numeric code (default: SEVDESK_INVOICE_STATUS, else Open)
  --poll-window-days <n>    only fetch invoices dated within n days back; 0 disables (default: 30)
  --state <path>           high-water-mark file (default: SEVDESK_STATE_FILE, else .beliq-sevdesk-state.json)
  --output <dir>           where converted documents are written (default: SEVDESK_OUTPUT_DIR, else ./out)
  --interval <seconds>     seconds between polls in daemon mode (default: 300)
  --sevdesk-token <token>  sevDesk API token (default: SEVDESK_API_TOKEN)
  --api-key <key>          beliq API key (default: BELIQ_API_KEY)
  --notify-webhook <url>   POST a JSON poll report here (default: SEVDESK_NOTIFY_WEBHOOK)
  -h, --help               show this help
  -v, --version            show the version

Exit codes (meaningful with --once):
  0  every processed invoice was valid, or there was nothing to do
  1  at least one invoice failed validation
  2  config/usage error (missing token/key, bad flag or value)
  3  a sevDesk or beliq API error, or an invoice that errored mid-pipeline
  4  I/O error (unreadable state file, unwritable output)

Set SEVDESK_API_TOKEN (Settings -> Advanced -> API) and BELIQ_API_KEY (beliq
dashboard -> API Keys). The sevDesk token never leaves this environment.

With a notify webhook set, SEVDESK_NOTIFY_ON=failure (default) POSTs only when an
invoice fails; SEVDESK_NOTIFY_ON=always POSTs after every poll.
`
