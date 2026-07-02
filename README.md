# beliq-sevdesk

A small, self-hostable worker that polls [sevDesk](https://sevdesk.de) for your
e-invoices, converts each one to the format a counterparty actually needs, and
validates it against beliq's authority-pinned, drift-checked rules.

sevDesk generates one configured e-invoice format and trusts its own output. This
worker adds the two things it cannot:

- **Conversion.** sevDesk emits its single configured format. When a counterparty
  needs a different one (ZUGFeRD to Peppol BIS UBL, or a French Factur-X profile),
  the worker retargets each invoice with `beliq convert`.
- **An independent verdict.** `beliq validate` gives an authority-pinned second
  opinion sevDesk does not provide, catching profile-specific gaps such as BR-DE
  rules or a missing buyer reference / Leitweg-ID for public buyers.

Your **sevDesk token never leaves your environment**: the worker runs where you
run it, reads invoices directly from sevDesk, and only sends the invoice document
to beliq for validation and conversion.

## Install

```bash
npm install -g beliq-sevdesk
# or run without installing:
npx beliq-sevdesk --once
```

Requires Node.js >= 20.15.

## Quick start

Set the two credentials, point it at the invoices you care about, and run it once:

```bash
export SEVDESK_API_TOKEN=...   # sevDesk: Settings -> Advanced -> API
export BELIQ_API_KEY=...       # beliq dashboard -> API Keys
export SEVDESK_TARGET_FORMATS=peppol-bis

beliq-sevdesk --once
```

That polls your Open invoices from the last 30 days, converts each to Peppol BIS
UBL (written to `./out`), validates each one, prints a one-line summary, and exits
with a code you can gate on. Leave `SEVDESK_TARGET_FORMATS` empty to run
validation-only (no conversion, no files written).

Copy [.env.example](.env.example) to `.env` for the full set of settings.

## How each invoice is processed

For every invoice newer than the last one it saw (tracked by a persisted
high-water-mark, so nothing is processed twice):

1. Pull the invoice XML from sevDesk (`GET /Invoice/{id}/getXml`).
2. Convert it to each configured target format and write the bytes to the output
   dir as `<invoiceNumber>-<target>.<ext>` (`.pdf` for facturx / zugferd, else
   `.xml`). Any elements a conversion could not carry across are logged.
3. Validate the source document and classify it: `valid`, `invalid`, or `error`
   (the pipeline threw before a verdict).

The high-water-mark advances only across a leading run of invoices that got a
verdict. An invoice that errors (and any after it in the same batch) is left for
the next poll, which is safe because reprocessing is idempotent.

## Run once, or as a daemon

- `--once` polls a single time and exits. Use this from cron or CI.
- With no `--once`, it loops, polling every `SEVDESK_POLL_INTERVAL_SECONDS`
  (default 300) until the process is stopped.
- `--dry-run` walks the full pipeline (real API calls, real verdicts) but writes
  no files and persists no state. Good for a first, safe look.

A cron entry that runs it every 15 minutes:

```cron
*/15 * * * * SEVDESK_API_TOKEN=... BELIQ_API_KEY=... SEVDESK_TARGET_FORMATS=peppol-bis /usr/bin/beliq-sevdesk --once >> /var/log/beliq-sevdesk.log 2>&1
```

## Run it in a container

A prebuilt multi-arch image (amd64 + arm64) is published to GitHub Container
Registry:

```bash
docker pull ghcr.io/beliq-eu/beliq-sevdesk:latest
```

The image ships only the compiled worker and `@beliq/sdk` from the public npm
registry. No private beliq source is in it: all validation and conversion happen
on the beliq API over HTTPS.

The container's entrypoint is the worker, so arguments pass straight through. Run
a single poll:

```bash
docker run --rm \
  -e SEVDESK_API_TOKEN -e BELIQ_API_KEY -e SEVDESK_TARGET_FORMATS=peppol-bis \
  -v "$PWD/out:/app/out" -v "$PWD/state:/app/state" \
  ghcr.io/beliq-eu/beliq-sevdesk:latest --once
```

Inside the image the state file defaults to `/app/state/state.json` and the
output dir to `/app/out`; mount volumes there to persist the high-water-mark and
the converted documents across restarts. With no arguments the container loops as
a daemon.

## Example recipes

Ready-to-copy deployment recipes are in [examples/](examples/):

- [docker-compose.yml](examples/docker-compose.yml) runs it as a restart-on-failure daemon.
- [beliq-sevdesk.service](examples/beliq-sevdesk.service) + [beliq-sevdesk.timer](examples/beliq-sevdesk.timer) run it natively on a systemd timer (no Docker).
- [github-actions-cron.yml](examples/github-actions-cron.yml) polls on a schedule from GitHub Actions, failing the run when an invoice fails.

## Notify on failures

Set a webhook to get a JSON report POSTed after a poll:

```bash
export SEVDESK_NOTIFY_WEBHOOK=https://hooks.example.com/your/endpoint
# SEVDESK_NOTIFY_ON=failure (default) posts only when an invoice fails;
# SEVDESK_NOTIFY_ON=always posts after every poll (a heartbeat, good for cron).
```

The body:

```json
{
  "ok": false,
  "summary": "processed 2 invoice(s): 1 valid, 1 invalid, 0 error",
  "counts": { "valid": 1, "invalid": 1, "error": 0 },
  "invoices": [
    { "id": "10", "invoiceNumber": "INV-10", "classification": "valid" },
    { "id": "11", "invoiceNumber": "INV-11", "classification": "invalid" }
  ],
  "polledAt": "2025-06-15T12:00:00.000Z"
}
```

Notify is best-effort: a slow, dead, or non-2xx endpoint is logged (host only, so
a secret in the webhook path is never printed) and never changes the exit code.
The exit code always reflects the invoices, not the notification.

## Configuration

Every setting is read from the environment; the flags below override the matching
variable.

| Variable | Flag | Default | Description |
|---|---|---|---|
| `SEVDESK_API_TOKEN` | `--sevdesk-token` | (required) | sevDesk API token. |
| `BELIQ_API_KEY` | `--api-key` | (required) | beliq API key. |
| `SEVDESK_TARGET_FORMATS` | `--target-format` | (none) | Comma-separated convert targets. Empty = validation-only. |
| `SEVDESK_TARGET_PROFILE` | | (none) | Factur-X / ZUGFeRD profile, for a facturx / zugferd target. |
| `SEVDESK_INVOICE_STATUS` | `--status` | `Open` | `Draft`, `Open`, `Paid`, or a numeric code. |
| `SEVDESK_POLL_WINDOW_DAYS` | `--poll-window-days` | `30` | Only fetch invoices dated within n days back; `0` disables. |
| `SEVDESK_STATE_FILE` | `--state` | `.beliq-sevdesk-state.json` | The persisted high-water-mark. |
| `SEVDESK_OUTPUT_DIR` | `--output` | `./out` | Where converted documents are written. |
| `SEVDESK_POLL_INTERVAL_SECONDS` | `--interval` | `300` | Seconds between polls in daemon mode. |
| `SEVDESK_PAGE_SIZE` | | `100` | Page size for the invoice listing. |
| `SEVDESK_MAX_RETRIES` | | `4` | Retries on a sevDesk 429 / 5xx / network error. |
| `SEVDESK_NOTIFY_WEBHOOK` | `--notify-webhook` | (none) | POST a JSON poll report here. Empty = no notifications. |
| `SEVDESK_NOTIFY_ON` | | `failure` | `failure` (only on a failed invoice) or `always` (every poll). |
| `SEVDESK_BASE_URL` | | `https://api.sevdesk.de/api/v1` | Override for a mock or a future version. |
| `BELIQ_BASE_URL` | | `https://api.beliq.eu` | Override for a self-hosted beliq. |
| `BELIQ_AUTH` | | `header` | How the beliq key is sent: `header` (X-API-Key) or `bearer`. |

Allowed target formats: `cii`, `ubl`, `zugferd`, `facturx`, `xrechnung`,
`peppol-bis`. Allowed profiles: `basicwl`, `en16931`, `extended`,
`extended-ctc-fr`.

## Exit codes

Meaningful with `--once`, so cron and CI can act on the result:

| Code | Meaning |
|---|---|
| 0 | every processed invoice was valid, or there was nothing to do |
| 1 | at least one invoice failed validation |
| 2 | config / usage error (missing token or key, bad flag or value) |
| 3 | a sevDesk or beliq API error, or an invoice that errored mid-pipeline |
| 4 | I/O error (unreadable state file, unwritable output) |

An error (code 3) outranks an invalid document (code 1): not getting a verdict is
worse than getting a bad one.

## Logging

Structured events are written to stderr, one JSON object per line, for log
aggregation. The final human-readable summary is written to stdout, so
`beliq-sevdesk --once | tail -1` gives you the verdict while logs stay separate.

## A note on the sevDesk token

The sevDesk API token is account-wide, unscoped, and does not expire. This worker
is built so that token stays on your side: it never sends the token anywhere but
sevDesk, and it is not a hosted service holding your credentials. Store it the way
you store any production secret.

## Development

```bash
npm install
npm run build
npm test              # unit tests, no network
npm run scrub:check   # no em-dash

# build the container image locally:
docker build -t beliq-sevdesk .

# live smoke against the real sevDesk + beliq APIs (skipped without creds):
SEVDESK_API_TOKEN=... BELIQ_API_KEY=... npm run test:integration
```

## License

MIT
