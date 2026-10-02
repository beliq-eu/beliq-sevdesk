# beliq-sevdesk

A small, self-hostable worker that polls [sevDesk](https://sevdesk.de) for your
e-invoices, validates each one against beliq's authority-pinned, drift-checked
rules, and converts it to the formats a counterparty needs.

sevDesk's API hands out an e-invoice as one XML document. On the account this
worker was tested against in October 2026, that is UN/CEFACT CII declaring the
XRechnung 3.0 specification. The worker adds two things:

- **An independent verdict.** sevDesk checks that the fields an e-invoice needs
  are filled before the invoice may leave draft: it refuses one without a buyer
  reference, for example. Its API has no validation endpoint and returns no
  validation result. `beliq validate` checks the finished document against KoSIT's XRechnung
  rules. One case from that account: sevDesk took an IBAN that is not a correct
  IBAN, and beliq reported it as warning `BR-DE-19`.
- **Conversion.** When a counterparty needs another syntax or profile, the worker
  converts each invoice with `beliq convert`. See
  [What you can convert to](#what-you-can-convert-to).

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
export SEVDESK_TARGET_FORMATS=xrechnung

beliq-sevdesk --once
```

That polls your Open invoices from the last 30 days, validates each one, converts
each to XRechnung in UBL syntax (written to `./out`), prints a one-line summary,
and exits with a code you can gate on. Leave `SEVDESK_TARGET_FORMATS` empty to run
validation-only (no conversion, no files written).

Copy [.env.example](.env.example) to `.env` for the full set of settings.

## How each invoice is processed

For every listed invoice the worker has not finished yet (it keeps the finished
ids in a state file, so nothing is processed twice):

1. Pull the invoice XML from sevDesk (`GET /Invoice/{id}/getXml`).
2. Validate the document and classify it: `valid`, `invalid`, or `error` (no
   verdict).
3. Convert it to each configured target format and write the bytes to the output
   dir as `<invoiceNumber>-<target>.<ext>`. The extension follows what beliq
   returns: `.xml` for an XML document, `.pdf` for a PDF. Any elements a
   conversion could not carry across are logged.

The worker validates the document sevDesk produced. It does not validate the
converted files, and neither does `beliq convert`: a conversion rewrites the
syntax and the specification id, not the content. Validate a converted file
yourself before you rely on it.

Each invoice stands alone. One that fails for a reason that can pass (sevDesk or
beliq unreachable, a spent quota, a wrong key, a full disk) is tried again on the
next poll, and the invoices after it are still processed.

If beliq refuses the document itself, because it cannot be read or because the
conversion is not possible, the invoice is reported once and not tried again. It
counts as `error`, unless validation already found it `invalid`. The log line
`validate.refused` or `convert.refused` carries beliq's status and error code.

An invoice that was still a draft while a newer one was processed is picked up
on the first poll that lists it.

Each invoice is checked once. On the tested account sevDesk locks an invoice when
it is opened, so its document cannot change afterwards.

sevDesk holds XML only for invoices created as e-invoices, and its invoice list
does not say which ones those are. So the worker asks for the XML of every listed
invoice. For a normal invoice sevDesk answers that it is not an electronic
invoice; the worker counts it as `skipped`, logs `invoice.skipped` once and does
not ask again. A skipped invoice does not change the exit code.

### Which invoices are listed

Each poll lists the invoices in the configured status whose invoice date lies
within the last `SEVDESK_POLL_WINDOW_DAYS` days (default 30). sevDesk filters on
the invoice date, not on when the invoice was created or opened. An invoice dated
before the window is not listed, even when it was created or opened today:
opening a draft does not move its invoice date. Set `SEVDESK_POLL_WINDOW_DAYS=0`
to list every invoice in that status on every poll.

An invoice is seen only while it is in the configured status. When a part
payment is booked on an Open invoice, sevDesk moves it to another status and the
Open list no longer returns it.

### What you can convert to

Measured with the XML of the tested account. Each of these came back with no lost
elements:

| Target | What comes back |
|---|---|
| `xrechnung` | UBL, declaring XRechnung 3.0 |
| `ubl` | UBL, declaring plain EN 16931 |
| `cii` | CII |
| `zugferd`, `facturx` | CII XML with that profile's specification id. Not a PDF: sevDesk's API gives the worker XML, and beliq builds a PDF only from a PDF source. `SEVDESK_TARGET_PROFILE` picks the profile |

`peppol-bis` does not work. Peppol BIS needs a Peppol endpoint identifier for the
seller and the buyer, sevDesk's XML carries neither, and beliq does not make one
up. beliq refuses the conversion (`CONVERSION_LOSSY_FAILCLOSED`) and the invoice
is reported as `error`.

## Run once, or as a daemon

- `--once` polls a single time and exits. Use this from cron or CI.
- With no `--once`, it loops, polling every `SEVDESK_POLL_INTERVAL_SECONDS`
  (default 300) until the process is stopped.
- `--dry-run` walks the full pipeline (real API calls, real verdicts) but writes
  no files and persists no state. Good for a first, safe look.

A cron entry that runs it every 15 minutes:

```cron
*/15 * * * * SEVDESK_API_TOKEN=... BELIQ_API_KEY=... SEVDESK_TARGET_FORMATS=xrechnung /usr/bin/beliq-sevdesk --once >> /var/log/beliq-sevdesk.log 2>&1
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
  -e SEVDESK_API_TOKEN -e BELIQ_API_KEY -e SEVDESK_TARGET_FORMATS=xrechnung \
  -v "$PWD/out:/app/out" -v "$PWD/state:/app/state" \
  ghcr.io/beliq-eu/beliq-sevdesk:latest --once
```

Inside the image the state file defaults to `/app/state/state.json` and the
output dir to `/app/out`; mount volumes there to persist the state file and
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
  "summary": "processed 2 invoice(s): 1 valid, 1 invalid, 0 error, 0 skipped",
  "counts": { "valid": 1, "invalid": 1, "error": 0, "skipped": 0 },
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
| `SEVDESK_STATE_FILE` | `--state` | `.beliq-sevdesk-state.json` | The state file: the ids of the invoices already processed. |
| `SEVDESK_OUTPUT_DIR` | `--output` | `./out` | Where converted documents are written. |
| `SEVDESK_POLL_INTERVAL_SECONDS` | `--interval` | `300` | Seconds between polls in daemon mode. |
| `SEVDESK_PAGE_SIZE` | | `100` | Page size for the invoice listing. |
| `SEVDESK_MAX_RETRIES` | | `4` | Retries on a sevDesk 429 / 5xx / network error. |
| `SEVDESK_NOTIFY_WEBHOOK` | `--notify-webhook` | (none) | POST a JSON poll report here. Empty = no notifications. |
| `SEVDESK_NOTIFY_ON` | | `failure` | `failure` (only on a failed invoice) or `always` (every poll). |
| `SEVDESK_BASE_URL` | | `https://my.sevdesk.de/api/v1` | Override for a mock or a future version. |
| `BELIQ_BASE_URL` | | `https://api.beliq.eu` | Override for a self-hosted beliq. |
| `BELIQ_AUTH` | | `header` | How the beliq key is sent: `header` (X-API-Key) or `bearer`. |

Allowed target formats: `cii`, `ubl`, `zugferd`, `facturx`, `xrechnung`,
`peppol-bis`. Allowed profiles: `basicwl`, `en16931`, `extended`,
`extended-ctc-fr`.

## Exit codes

Meaningful with `--once`, so cron and CI can act on the result:

| Code | Meaning |
|---|---|
| 0 | every processed invoice was valid or skipped, or there was nothing to do |
| 1 | at least one invoice failed validation |
| 2 | config / usage error (missing token or key, bad flag or value) |
| 3 | a sevDesk or beliq API error, an invoice that errored mid-pipeline, or a document beliq refused to validate or convert |
| 4 | I/O error (unreadable state file, unwritable output) |

An error (code 3) outranks an invalid document (code 1): not getting a verdict is
worse than getting a bad one.

## Upgrading from 0.2.x

0.2.x stored one number in the state file: the highest invoice id it had
processed. The first poll after the upgrade reads that number, marks every listed
invoice with an id at or below it as processed, and rewrites the file as a list
of ids. Nothing needs to be done by hand.

One thing to know. 0.2.x skipped an invoice that was still a draft while a newer
invoice was processed. The old file cannot tell such an invoice from a processed
one, so the upgrade marks it as processed too. To have every invoice in the
current poll window processed again, delete the state file before the first run.
That validates and converts those invoices again and uses beliq quota for each.

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
