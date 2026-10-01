# Agent rules for the beliq connectors, SDKs and tools

<!--
The same file, byte for byte, in every beliq-eu repo. To change it, edit the copy in
beliq-eu/.github and copy it over the others in the same pass. The promise block is generated:
do not edit between its two markers.
-->

This repo is one of the public beliq-eu repos that put the beliq e-invoice API in front of
users: the SDKs, the CLI, the MCP server, the GitHub Action, the connectors and shop plugins,
and the shared configuration in `beliq-eu/.github`. These rules bind every change in any of
them, whoever or whatever makes it.

<!-- beliq-promise:start -->
<!-- Generated from beliq-types/PROMISE.md by beliq-types/scripts/promise-block.mjs. Do not edit between the two markers: change PROMISE.md, then rerun the script. -->
## The beliq promise

**What beliq promises.** For each e-invoice format, beliq checks a document against the highest
standard that exists for that format, and shows what backs every verdict: the rule pack, its
version and a badge for how deep the check goes.

**What that asks of every change, in every repo.**

- Every format, field, business rule, default and derived value traces to an official public
  source: CEN/TC 434, KoSIT, FNFE-MPE, OpenPeppol, OASIS, UN/CEFACT or the national tax authority.
  A blog post, a forum answer, a vendor paper or a competitor's behaviour is not a source.
- Where no source settles a value, stop and say so. Do not fill the gap with a plausible value, a
  rounding or a fallback. This binds what beliq generates, converts and parses as much as its
  verdicts.
- Claim only what the code does today, on every surface: API responses, docs, landing page, legal
  texts, emails, the support bot, connectors, and PR and commit text.
- Read versions, error codes, statuses and badges from their one source
  (`beliq-engine/third-party/versions.json`, `beliq-engine/compliance/profile-status.json`,
  `beliq-types/src/api.ts`, `beliq-types/src/coverage/`). Do not type a copy by hand.

**The limits, which are part of the promise.**

- `valid` means the document passed the rule packs and schemas listed for its format, in the
  stated versions. It does not mean every recipient, validation tool or tax authority accepts it.
- The depth of the check differs by format, and the badge says which: `Authority-checked` (the
  authority's own rules), `Community-checked` (real business rules from an independent pack, not
  the authority's own), `Schema-checked` (structure only, no business rules). Never show a
  verdict as deeper than its badge.
- beliq is a format vendor, not a transmission operator. `beliq-types/docs/transmission-boundary.md`
  says what it does and does not operate.

The rules behind each line, each with the condition that makes it bind:
`beliq-types/docs/README.md`.
<!-- beliq-promise:end -->

## Reading the promise from this repo

`beliq-engine/` and `beliq-types/` in the block above are beliq's core repos, and they are
private. From a clone of this repo alone, the public views of the same facts are:

- `https://api.beliq.eu/openapi.json`: the fields, enums and error codes the API accepts and
  returns.
- `GET https://api.beliq.eu/v1/rulesets`, which takes no API key: each format beliq offers
  with its rule pack, the version in force, its verification tier and its badge. Documented at
  https://docs.beliq.eu/api-reference/rulesets/.

If neither settles a question, that is the promise's "stop and say so" case.

A README, a store or marketplace listing, a dropdown label, a tool description, a sample
response and an error message are all surfaces in the sense of the promise.

## Never

- **Put a value into an invoice that the source system does not hold.** A connector, plugin or
  SDK helper passes on what the shop, the ERP, the flow or the caller gave it. When a field the
  target format requires is missing, name the missing field and stop, or ask the user for it.
  Do not fill it so that validation passes. The filling has three shapes: a **default** (a
  literal name, code or identifier), a **derived value** (a rate worked out from amounts, or
  one field's value used for another field) and a **precision change** (rounding or cutting an
  amount, price, rate or quantity the source holds). Each is allowed only where the authority's
  specification prescribes that value or that calculation, and the code names the clause at
  the place it applies it. A document that validates is no evidence: the rules accept values
  that are wrong for the invoice in hand. The same holds for text a repo hands to a model, such
  as the MCP server's tool descriptions and skill: it tells the model to ask the user for
  missing invoice data, not to make it up.

  Code in these repos that predates this rule and fills such a value (an order number used
  as the buyer reference, a placeholder buyer name, a VAT rate worked out from rounded
  amounts) is an open defect, not a precedent. Do not copy it and do not add to it.

- **Cite a rule from memory.** Read a rule's ID and text in the authority's own pack before
  writing it into code, a comment, a message or a doc. For XRechnung that pack is KoSIT's
  Schematron, https://github.com/itplr-kosit/xrechnung-schematron. The error this prevents:
  the rule that requires the buyer reference (BT-10) is BR-DE-15. BR-DE-1 requires the payment
  instructions (BG-16).

- **Type a list of formats, standards, profiles or versions from memory.** The option lists in
  these repos (the SDKs' `LIVE_*` constants, the connectors' dropdowns, the MCP server's enums)
  and the versions in sample data are copies. Their source is beliq's coverage manifest,
  `beliq-types/src/coverage/`, which `GET /v1/rulesets` publishes, and the API's own enums in
  `openapi.json`. Read a value there before adding or removing it. A value the API accepts but a
  list leaves out gets its reason written beside it, and the reason has to be true today.

  Where a list is typed by hand and no CI job compares it with the manifest, that reading is
  yours to do. A comment that calls FatturaPA, Facturae or e-SLOG "provisional" or "withheld
  per LPD-1" gives a reason that ended on 2026-07-14, when beliq began to show every format it
  carries with its badge. Do not repeat it.
