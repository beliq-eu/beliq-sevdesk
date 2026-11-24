# Changelog

This file starts at 0.4.0. An earlier version has a heading here only for a
breaking change; the rest of its changes are in the git history between the
version tags (https://github.com/beliq-eu/beliq-sevdesk/tags). 0.1.0 is on npm
without a tag. Dates are the npm publish date, in UTC.

## 0.6.0 - 2026-11-24

- Breaking: the worker needs Node.js 22 or later (`engines.node` `>=22`). Before,
  it declared `>=20.15`. Node 20 reached end of life on 2026-04-30. CI tests
  Node 22 and Node 26.
- The container image runs Node 26 (`node:26-bookworm-slim`, Node 26.13.1).
  Before, it ran Node 22. Nothing changes in how the image is run.
- The image is built with `@beliq/sdk` 0.7.6. Before, it was 0.7.3.

## 0.5.0 - 2026-11-16

- When beliq is unavailable (a `503` `DATABASE_UNAVAILABLE`, a `502` or `503`
  with no beliq error code, or a connection that cannot be opened), the beliq
  client retries for up to 15 minutes, plus the last attempt's deadline of up
  to 90 seconds. Before, it retried 3 times. If beliq is still out, that
  invoice is reported as `error`, a `poll.outage` line says how many invoices
  were not tried, and the poll stops. All of them come back in the next poll.
- A run that meets an outage can now last longer than 15 minutes. The README's
  cron example wraps the worker in `flock -n`, so a run is skipped while the
  one before it is still going; two runs at once would share one state file.
- On SIGTERM or SIGINT the worker stops at once, also while it waits to retry
  an outage. A beliq call that is running is ended, its invoice is left for
  the next run, and a `poll.stopped` line says how many invoices were not
  tried. Before, the worker finished the invoice in hand first. A sevDesk call
  still runs to its end.
- The worker is on `@beliq/sdk` 0.7.3. The `convert` log line's
  `lostElements` count is unchanged.

## 0.4.0 - 2026-10-24

- Breaking: an invoice whose validation result carries
  `franceCtcBlockingRuleIds` counts as `invalid`, also where `valid` is true,
  and the run exits 1. A `validate.franceCtcBlock` log line with the ids comes
  before the `validate` line.
- The `validate` log line has a `checkDepth` field: the check depth the API
  states, or `check depth not stated` where it states none.
- Container image: both build stages pin `node:22-bookworm-slim` by digest, and
  each platform image is scanned for fixable CRITICAL vulnerabilities before
  it is pushed.

## 0.3.0 - 2026-10-02

- Breaking: the state file stores the processed invoice ids (`processedIds`),
  not one number (`lastInvoiceId`). The first poll converts an old file, and a
  0.2.x worker cannot read the new one.
- Breaking: the file extension follows what beliq returns. A `facturx` or
  `zugferd` target converted from sevDesk XML is written as
  `<invoiceNumber>-<target>.xml`, not `.pdf`.
- Breaking: an invoice that is not an e-invoice counts as `skipped` and no
  longer moves the exit code. Before, it counted as `error`, gave exit 3 and
  was retried.
- Breaking: an invoice list that does not end within 100 pages fails the poll.
  Before, the first 100 pages were processed.
- Breaking: the `poll` log line has `known` in place of `since`.

## 0.2.4 - 2026-09-28

- Breaking: the container image no longer contains npm or npx. The entrypoint
  is unchanged.
