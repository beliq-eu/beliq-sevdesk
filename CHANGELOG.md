# Changelog

This file starts at 0.4.0. An earlier version has a heading here only for a
breaking change; the rest of its changes are in the git history between the
version tags (https://github.com/beliq-eu/beliq-sevdesk/tags). 0.1.0 is on npm
without a tag. Dates are the npm publish date, in UTC.

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
